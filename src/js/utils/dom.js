
// Get parsed html from xhr
export function parseHTML(str) {
  let tmpXML = document.implementation.createHTMLDocument();
  tmpXML.body.innerHTML = str;
  let bodyXML = tmpXML.body.children;

  for (let i in bodyXML) {
    let $wrap = bodyXML[i].querySelector('#wrap');
    if ($wrap !== null) return $wrap;
  }
}

// Inject element's html in wrapper
export function loadPage(element) {
  document.querySelector('#content').innerHTML = element.innerHTML;
}