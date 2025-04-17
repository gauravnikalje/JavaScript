//+------------------------------------------------------------------+
//|                         GOLDEXPERT43.mq5                         |
//|                Copyright @ 2025, Gaurav Nikalje                  |
//|                    XAUUSD Automated Trading                      |
//+------------------------------------------------------------------+
#property copyright "Copyright @ 2025, Gaurav Nikalje"
#property version   "1.10"

#include <Trade\Trade.mqh>
#include <WinAPI\winbase.mqh>

// Set the trading timeframe to 15 minutes (for XAUUSD)
#define TRADE_TIMEFRAME PERIOD_M15

CTrade ExtTrade;

// EMA settings and risk parameters
#define EMA_PERIOD_1 32
#define EMA_PERIOD_2 200
#define MA_MAGIC 1234501

// Input parameters for risk management
input double FIXED_SL_DOLLARS = 25.0;     // Fixed stop loss in dollars (0 to disable, independent value)
input int    Maximum_stop_losses_per_month = 2; // Maximum stop losses per month (0 = no SL, 1-5 = number of SL triggers allowed)

// Daily limits and profit management
#define DAILY_MAX_PROFIT 6.0       // Maximum daily profit in dollars
#define DAILY_TRADE_LIMIT 3        // Maximum trades per day
#define TP_PERCENTAGE 0.005        // 0.5% of account balance used to compute desired profit

// Fixed lot size (set to 0.02)
input double LotSize = 0.02;

// Nadaraya-Watson Envelope indicator parameters
input string NW_Indicator_Name = "NadarayaWatsonEnvelope"; // Must match the custom indicator name
input int NW_Period = 14;         // Example period for NW indicator
input double NW_Deviation = 0.005;  // Example deviation

// ===== TPO Settings =====
input string TPO_Session = "0000-0800";   // TPO session for XAUUSD (server time, 00:00â€“08:00)
input int    TPO_Ticks = 25;              // Ticks per TPO (multiplied by syminfo.mintick)
double TickSize = TPO_Ticks * SymbolInfoDouble(_Symbol, SYMBOL_POINT);  // Actual tick size for TPO
// Global variable to store last session's TPO POC
double LastSessionPOC = 0.0;  

// For TPO session timing, we use 00:00â€“08:00 (server time)
// We'll use the 15-minute timeframe's bar times to detect session start/end.
int SessionStartIndex = -1;

//===== Global Variables for EA =====
double highestEquity = 0.0;
double dailyStartingBalance = 0.0;
int tradesToday = 0;
int lastTradeDay = -1; // Last day when daily counters were reset
int stopLossesThisMonth = 0; // Counter for stop losses this month
int lastMonth = -1; // Last month when stop loss counter was reset
datetime SLHaltUntil = 0; // Timestamp for when trading can resume after SL halt
bool restartEA = false;

datetime lastBarTime = 0;

// New variable for trade profit targets
double TRADE_PROFIT_TARGETS[3] = {3.0, 2.0, 1.0}; // Profit targets for trade 1, 2, 3 in dollars

//+------------------------------------------------------------------+
//| TPO Helper Functions                                             |
//+------------------------------------------------------------------+
// Check if the current M15 bar is the first bar of our TPO session
bool IsTPOSessionStart()
  {
   datetime time_prev = iTime(_Symbol, TRADE_TIMEFRAME, 1);
   datetime time_curr = iTime(_Symbol, TRADE_TIMEFRAME, 0);
   MqlDateTime dt_prev, dt_curr;
   TimeToStruct(time_prev, dt_prev);
   TimeToStruct(time_curr, dt_curr);
   int prevHM = dt_prev.hour*100 + dt_prev.min;
   int currHM = dt_curr.hour*100 + dt_curr.min;
   // Session starts at 00:00
   return (prevHM < 0 && currHM >= 0);
  }
  
// Check if the current M15 bar is the first bar after our TPO session ends
bool IsTPOSessionEnd()
  {
   datetime time_prev = iTime(_Symbol, TRADE_TIMEFRAME, 1);
   datetime time_curr = iTime(_Symbol, TRADE_TIMEFRAME, 0);
   MqlDateTime dt_prev, dt_curr;
   TimeToStruct(time_prev, dt_prev);
   TimeToStruct(time_curr, dt_curr);
   int prevHM = dt_prev.hour*100 + dt_prev.min;
   int currHM = dt_curr.hour*100 + dt_curr.min;
   // Session ends at 08:00
   return (prevHM < 800 && currHM >= 800);
  }
  
// Update TPO profile for the session that just ended and compute the POC.
void UpdateTPOProfile()
  {
   int totalBars = Bars(_Symbol, TRADE_TIMEFRAME);
   if(SessionStartIndex < 0 || totalBars < SessionStartIndex)
      return;
      
   int sessionEndIndex = totalBars - 1;
   double sessHigh = -DBL_MAX;
   double sessLow = DBL_MAX;
   for(int i = SessionStartIndex; i <= sessionEndIndex; i++)
     {
      double barHigh = iHigh(_Symbol, TRADE_TIMEFRAME, i);
      double barLow  = iLow(_Symbol, TRADE_TIMEFRAME, i);
      if(barHigh > sessHigh) sessHigh = barHigh;
      if(barLow < sessLow) sessLow = barLow;
     }
     
   double range = sessHigh - sessLow;
   int binCount = (int)MathFloor(range / TickSize);
   if(binCount <= 0)
      return;
      
   int bestBin = 0;
   int bestCount = 0;
   for(int bin = 0; bin < binCount; bin++)
     {
      double binTop = sessHigh - bin * TickSize;
      double binBottom = binTop - TickSize;
      int count = 0;
      for(int i = SessionStartIndex; i <= sessionEndIndex; i++)
        {
         double barHigh = iHigh(_Symbol, TRADE_TIMEFRAME, i);
         double barLow  = iLow(_Symbol, TRADE_TIMEFRAME, i);
         if(barHigh >= binBottom && barLow <= binTop)
            count++;
        }
      if(count > bestCount)
        {
         bestCount = count;
         bestBin = bin;
        }
     }
     
   double binTop = sessHigh - bestBin * TickSize;
   double poc = binTop - TickSize / 2.0;
   LastSessionPOC = poc;
   Print("TPO Updated: POC=", poc);
  }
  
//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
   Print("EA Initialization started for XAUUSD...");
   
   dailyStartingBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   highestEquity        = dailyStartingBalance;
   
   // Reset daily counter day
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   lastTradeDay = dt.day;
   lastMonth = dt.mon;
   
   stopLossesThisMonth = 0;
   SLHaltUntil = 0; // Initialize SL halt timestamp
   
   ExtTrade.SetExpertMagicNumber(MA_MAGIC);
   
   // Create EMA indicator handles
   int EMA_Handle_1 = iMA(_Symbol, TRADE_TIMEFRAME, EMA_PERIOD_1, 0, MODE_EMA, PRICE_CLOSE);
   int EMA_Handle_2 = iMA(_Symbol, TRADE_TIMEFRAME, EMA_PERIOD_2, 0, MODE_EMA, PRICE_CLOSE);
   if(EMA_Handle_1 == INVALID_HANDLE || EMA_Handle_2 == INVALID_HANDLE)
     {
      Print("ERROR: Failed to create EMA indicators");
      return(INIT_FAILED);
     }
   
   // Create the Nadaraya-Watson Envelope indicator handle
   int NW_Handle = iCustom(_Symbol, TRADE_TIMEFRAME, NW_Indicator_Name, NW_Period, NW_Deviation);
   if(NW_Handle == INVALID_HANDLE)
     {
      Print("ERROR: Failed to create Nadaraya-Watson Envelope handle");
      return(INIT_FAILED);
     }
   
   lastBarTime = iTime(_Symbol, TRADE_TIMEFRAME, 0);
   Print("EA Initialization completed successfully");
   
   // Log risk parameters
   if(FIXED_SL_DOLLARS > 0 && Maximum_stop_losses_per_month > 0)
      Print("Fixed SL enabled: $", FIXED_SL_DOLLARS, " with max ", Maximum_stop_losses_per_month, " SL triggers per month");
   else if(FIXED_SL_DOLLARS > 0 && Maximum_stop_losses_per_month == 0)
      Print("SL disabled (Maximum_stop_losses_per_month = 0, even though FIXED_SL_DOLLARS = ", FIXED_SL_DOLLARS, ")");
   else
      Print("SL disabled (FIXED_SL_DOLLARS = 0)");
      
   return(INIT_SUCCEEDED);
  }
  
//+------------------------------------------------------------------+
//| Check if a new 15-minute bar has formed                          |
//+------------------------------------------------------------------+
bool IsNewFifteenMinuteBar()
  {
   datetime currentBarTime = iTime(_Symbol, TRADE_TIMEFRAME, 0);
   if(currentBarTime != lastBarTime)
     {
      lastBarTime = currentBarTime;
      return true;
     }
   return false;
  }
  
//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
    MqlDateTime currentTime;
    TimeToStruct(TimeCurrent(), currentTime);
    
    // Check if trading is halted due to SL
    if(SLHaltUntil > TimeCurrent())
    {
        Print("Trading halted due to SL until ", TimeToString(SLHaltUntil));
        return;
    }
    
    // Trading restrictions based on day of week
    int currentHour = currentTime.hour;
    if(currentTime.day_of_week == 1 || currentTime.day_of_week == 5) // Monday or Friday
    {
        if(currentHour >= 8)
        {
            return; // No trading after 08:00
        }
    }
    else // Tuesday, Wednesday, Thursday
    {
        if(currentHour >= 8 && currentHour < 17)
        {
            return; // Halt trading from 08:00 to 17:00
        }
    }
    
    // Reset daily counters if a new day has begun
    int currentDay = currentTime.day;
    if(currentDay != lastTradeDay)
    {
        dailyStartingBalance = AccountInfoDouble(ACCOUNT_BALANCE);
        tradesToday          = 0;
        lastTradeDay         = currentDay;
        Print("Daily counters reset - Day: ", EnumToString((ENUM_DAY_OF_WEEK)currentTime.day_of_week));
    }
    
    // Reset monthly stop loss counter if a new month has begun
    if(currentTime.mon != lastMonth)
    {
        stopLossesThisMonth = 0;
        lastMonth = currentTime.mon;
        Print("Monthly stop loss counter reset - Month: ", currentTime.mon);
    }

    // Skip trading on Friday (redundant but kept for clarity)
    if(currentTime.day_of_week == 5 && currentHour >= 8)
        return;
    
    if(!IsNewFifteenMinuteBar())
        return;
    
    if(restartEA)
    {
        Print("Restarting EA, stopLossesThisMonth = ", stopLossesThisMonth);
        OnInit();
        restartEA = false;
        return;
    }
    
    double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
    double currentBalance = AccountInfoDouble(ACCOUNT_BALANCE);
    
    // Check for 50% drawdown from highest equity
    if(currentEquity < highestEquity * 0.5)
    {
        Print("CRITICAL: Equity dropped 50% below highest equity. Current Equity=", currentEquity, 
              " Highest Equity=", highestEquity, " Halting trading permanently.");
        CloseAllPositions();
        return; // Permanent halt
    }
    
    if(currentEquity > highestEquity)
    {
        highestEquity = currentEquity;
        Print("New highest equity: $", highestEquity);
    }
    
    // Debug: Log current SL state
    Print("SL Check: FIXED_SL_DOLLARS = ", FIXED_SL_DOLLARS, ", stopLossesThisMonth = ", stopLossesThisMonth, 
          ", Max SL per month = ", Maximum_stop_losses_per_month, ", Day = ", currentTime.day);
    
    // Check for SL being hit only if SL is enabled (FIXED_SL_DOLLARS > 0), positions exist, day >= 16, and Maximum_stop_losses_per_month > 0
    if(FIXED_SL_DOLLARS > 0 && PositionsTotal() > 0 && currentTime.day >= 16 && Maximum_stop_losses_per_month > 0)
    {
        Print("SL Monitoring Active: PositionsTotal = ", PositionsTotal(), ", Day = ", currentTime.day);
        // Loop through positions to check for SL breach
        for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
            ulong ticket = PositionGetTicket(i);
            if(PositionSelectByTicket(ticket) && PositionGetInteger(POSITION_MAGIC) == MA_MAGIC)
            {
                double positionProfit = PositionGetDouble(POSITION_PROFIT);
                Print("Checking position #", ticket, ": Profit = ", positionProfit);
                // If position loss exceeds fixed SL, close all positions and increment stop loss counter
                if(positionProfit <= -FIXED_SL_DOLLARS)
                {
                    Print("SL HIT: Position loss $", MathAbs(positionProfit), " exceeds SL of $", FIXED_SL_DOLLARS, 
                          ", stopLossesThisMonth before increment = ", stopLossesThisMonth);
                    CloseAllPositions();
                    stopLossesThisMonth++;
                    SLHaltUntil = TimeCurrent() + 4 * 24 * 3600; // Halt for 4 days
                    Print("Trading halted for 4 days until ", TimeToString(SLHaltUntil));
                    Print("After SL hit, stopLossesThisMonth = ", stopLossesThisMonth);
                    if(stopLossesThisMonth >= Maximum_stop_losses_per_month)
                    {
                        Print("Maximum ", Maximum_stop_losses_per_month, " stop losses for this month reached. Trading halted until next month.");
                        return; // Halt trading for the rest of the month
                    }
                    restartEA = true;
                    return;
                }
            }
        }
    }
    
    ManageOpenPositions();
    
    // Check if daily profit target is reached
    double dailyProfit = currentBalance - dailyStartingBalance;
    if(dailyProfit >= DAILY_MAX_PROFIT)
    {
        Print("INFO: Daily profit target reached. Profit=", dailyProfit);
        return;
    }
    
    // Do not open a new trade if a position exists or stop loss limit for the month is reached
    if(PositionsTotal() > 0 || stopLossesThisMonth >= Maximum_stop_losses_per_month)
        return;
    
    // ----- TPO Logic Integration -----
    // Check for TPO session start and end based on M15 bar times
    if(IsTPOSessionStart())
    {
        SessionStartIndex = Bars(_Symbol, TRADE_TIMEFRAME) - 1;
        Print("TPO session started at bar index=", SessionStartIndex);
    }
    if(IsTPOSessionEnd())
    {
        if(SessionStartIndex >= 0)
            UpdateTPOProfile();
    }
    // ----- End TPO Logic Integration -----
    
    // Check and place new trade only if TPO filter is satisfied
    CheckAndPlaceTrades();
}  
//+------------------------------------------------------------------+
//| Check market conditions and place trades (with TPO filter)       |
//+------------------------------------------------------------------+
void CheckAndPlaceTrades()
  {
   if(tradesToday >= DAILY_TRADE_LIMIT)
      return;
   
   if(Bars(_Symbol, TRADE_TIMEFRAME) < EMA_PERIOD_2)
     {
      Print("ERROR: Insufficient bars for calculation");
      return;
     }
   
   double EMA_1[1], EMA_2[1];
   MqlRates rates[2];
   
   if(CopyRates(_Symbol, TRADE_TIMEFRAME, 0, 2, rates) != 2)
     {
      Print("ERROR: Failed to copy rates data. Error=", GetLastError());
      return;
     }
   
   // Fetch EMA values
   if(CopyBuffer(iMA(_Symbol, TRADE_TIMEFRAME, EMA_PERIOD_1, 0, MODE_EMA, PRICE_CLOSE), 0, 0, 1, EMA_1) != 1 ||
      CopyBuffer(iMA(_Symbol, TRADE_TIMEFRAME, EMA_PERIOD_2, 0, MODE_EMA, PRICE_CLOSE), 0, 0, 1, EMA_2) != 1)
     {
      Print("ERROR: Failed to fetch EMA values. Error=", GetLastError());
      return;
     }
   
   // Fetch Nadaraya-Watson Envelope values (Buffer 0 = Upper, Buffer 1 = Lower)
   double NW_Upper[1], NW_Lower[1];
   int NW_Handle = iCustom(_Symbol, TRADE_TIMEFRAME, NW_Indicator_Name, NW_Period, NW_Deviation);
   if(CopyBuffer(NW_Handle, 0, 0, 1, NW_Upper) != 1 ||
      CopyBuffer(NW_Handle, 1, 0, 1, NW_Lower) != 1)
     {
      Print("ERROR: Failed to fetch NW Envelope values. Error=", GetLastError());
      return;
     }
   
   ENUM_ORDER_TYPE signal = WRONG_VALUE;
   
   // For Buy: close above both EMAs and above NW upper band
   if(rates[0].close > EMA_1[0] && rates[0].close > EMA_2[0] && rates[0].close > NW_Upper[0])
     {
      signal = ORDER_TYPE_BUY;
     }
   // For Sell: close below both EMAs and below NW lower band
   else if(rates[0].close < EMA_1[0] && rates[0].close < EMA_2[0] && rates[0].close < NW_Lower[0])
     {
      signal = ORDER_TYPE_SELL;
     }
   
   // ----- TPO Filter -----
   // For Buy, require current close > LastSessionPOC.
   // For Sell, require current close < LastSessionPOC.
   if(signal == ORDER_TYPE_BUY && rates[0].close < LastSessionPOC)
     {
      return;
     }
   if(signal == ORDER_TYPE_SELL && rates[0].close > LastSessionPOC)
     {
      return;
     }
   // ----- End TPO Filter -----
   
   if(signal != WRONG_VALUE)
     {
      double currentBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      double dailyProfit = currentBalance - dailyStartingBalance;
      if(dailyProfit >= DAILY_MAX_PROFIT)
        {
         return;
        }
      
      // Determine entry price based on order type
      double entryPrice = (signal == ORDER_TYPE_BUY) ? SymbolInfoDouble(_Symbol, SYMBOL_ASK)
                                                     : SymbolInfoDouble(_Symbol, SYMBOL_BID);
      
      // Retrieve dynamic contract size
      double dynamicContractSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_CONTRACT_SIZE);
      
      double targetPrice;
      // Set TP based on trade number (0 = first trade, 1 = second, 2 = third)
      double desiredProfit = TRADE_PROFIT_TARGETS[tradesToday];
      double priceDiff = desiredProfit / (LotSize * dynamicContractSize);
      targetPrice = (signal == ORDER_TYPE_BUY) ? entryPrice + priceDiff
                                               : entryPrice - priceDiff;
      Print("Setting trade ", tradesToday + 1, " with target profit of $", desiredProfit);
      
      if(currentBalance > 0) // Basic check to ensure account is valid
        {
         // Open position without stop loss price - we'll monitor for loss in tick function
         if(ExtTrade.PositionOpen(_Symbol, signal, LotSize, entryPrice, 0, targetPrice))
           {
            Print("Trade opened: ", (signal == ORDER_TYPE_BUY ? "BUY" : "SELL"),
                  " at ", entryPrice, " TP=", targetPrice);
            
            if(FIXED_SL_DOLLARS > 0 && Maximum_stop_losses_per_month > 0)
               Print("SL Monitoring enabled: $", FIXED_SL_DOLLARS, " with max ", Maximum_stop_losses_per_month, " SL triggers per month");
            else if(FIXED_SL_DOLLARS > 0 && Maximum_stop_losses_per_month == 0)
               Print("SL disabled (Maximum_stop_losses_per_month = 0, even though FIXED_SL_DOLLARS = ", FIXED_SL_DOLLARS, ")");
            else
               Print("SL disabled (FIXED_SL_DOLLARS = 0)");
               
            tradesToday++;
           }
         else
           {
            Print("ERROR: Trade failed. Error=", GetLastError());
           }
        }
     }
  }
  
//+------------------------------------------------------------------+
//| Manage open positions and close them if target profit is reached |
//+------------------------------------------------------------------+
void ManageOpenPositions()
  {
   int totalPositions = PositionsTotal();
   if(totalPositions == 0)
      return;

   for(int i = totalPositions - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) == MA_MAGIC)
           {
            double positionProfit = PositionGetDouble(POSITION_PROFIT);
            
            // Check for TP hit
            double dynamicTP = AccountInfoDouble(ACCOUNT_BALANCE) * TP_PERCENTAGE;
            if(positionProfit >= dynamicTP)
              {
               if(ExtTrade.PositionClose(ticket))
                  Print("Position closed with profit: ", positionProfit);
               else
                  Print("ERROR: Failed to close position #", ticket, " Error=", GetLastError());
              }
           }
        }
     }
  }
  
//+------------------------------------------------------------------+
//| Close all positions                                              |
//+------------------------------------------------------------------+
void CloseAllPositions()
  {
   int totalPositions = PositionsTotal();
   if(totalPositions == 0)
      return;
      
   Print("Closing all positions (Total=", totalPositions, ")");
   
   for(int i = totalPositions - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ExtTrade.PositionClose(ticket))
         Print("Position #", ticket, " closed successfully");
      else
         Print("ERROR: Failed to close position #", ticket, " Error=", GetLastError());
     }
  }
  
//+------------------------------------------------------------------+
