console.log('dat work');

import a from 'abyssa';
import ajax from './utils/ajax';


let router = a.Router({
  home: a.State('/', {
    enter: function(params) {
      console.log('enter home', params.id);
    },
    exit: function() {
      console.log('leave home');
    }
  },{
    post: a.State(':id', {
      enter: function(params) {
        console.log('enter post', params.id);
        // ajax(params.id, res => res);
      },
      exit: function() {
        console.log('leave post');
      }
    })
  }),
  tag: a.State('tag/:id', {
    enter: function(params) {
      console.log('enter tag', 'tag/'+ params.id);
    },
    exit: function() {
      console.log('leave tag');
    }
  }),
  author: a.State('author/:id', {
    enter: function(params) {
      console.log('enter author', 'author/'+ params.id);
    },
    exit: function() {
      console.log('leave author');
    }
  })
}).init();