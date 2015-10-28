export function ajax(options) {
  let { method, url, data } = options;

  return new Promise((resolve, reject) => {
    let xhr = new XMLHttpRequest();
  
    xhr.open(method, window.location.origin + url);
    xhr.onload = () => {
      if (xhr.status == 200) 
        resolve(xhr.responseText);
      else 
        reject(Error(xhr.statusText));
    };
    xhr.onerror = () => {
      reject(Error('Network Error'));
    };
    xhr.send(data);
  });
}