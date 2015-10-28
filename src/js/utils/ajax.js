import { parseHTML, loadPage } from './dom.js';


function ajax(url) {
  return new Promise((resolve, reject) => {
    let xhr = new XMLHttpRequest();
  
    xhr.open('GET', window.location.origin + url);
    xhr.onload = () => {
      if (xhr.status == 200)
        resolve(parseHTML(xhr.responseText));
      else
        reject(Error(xhr.statusText));
    };
    xhr.onerror = () => {
      reject(Error('Network Error'));
    };
    xhr.send();
  });
}


export function getHome() { 
  ajax('/').then(res => loadPage(res)) 
}

export function getPost(id) { 
  ajax('/'+ id).then(res => loadPage(res)) 
}

export function getTag(id) { 
  ajax('/tag/'+ id).then(res => loadPage(res)) 
}

export function getAuthor(id) { 
  ajax('/author/'+ id).then(res => loadPage(res)) 
}