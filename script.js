const input=document.getElementById("input");
const info=document.getElementById("info");
const meaning=document.getElementById("meaning-container");
const title=document.getElementById("title");
const meaning1=document.getElementById("meaning");
const audio=document.getElementById("audio");

async function fetchAPI(word){
    try {
        info.style.display="block"; 
        info.innerText=`Seaching the meaning of "${word}"`;  
        const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${word}`;
        const result= await fetch(url).then((res)=>res.json());
        if(result.title)
        {
            title.innerText=word;
        meaning1.innerText = "N/A";
        audio.style.display="none";
        }
        else{
        info.style.display="none";
        meaning.style.display="block";
        title.innerText=result[0].word;
        meaning1.innerText = result[0].meanings[0].definitions[0].definition;
        audio.src=result[0].phonetics[0].audio;
        console.log(result);
    }
    } catch (error) {
        console.log(error);
        info.innerText="An error occureed please try agagin letter...."
    }
} 


input.addEventListener("keyup",(e)=>{
        if(e.target.value && e.key=="Enter"){
        fetchAPI(e.target.value);
        }
});