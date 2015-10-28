import a from 'abyssa';

import { getHome, getPost, getTag, getAuthor } from './utils/ajax';


let Router = a.Router({
  index: a.State('/', {
    enter: (params) => {
      if (!Router.isFirstTransition()) console.log('test');
    }
    // exit: () => console.log('leave home')
  },{
    home: a.State('', {
      enter: (params) => { 
        if (!Router.isFirstTransition()) getHome()
      }
      // exit: () => console.log('leave home')
    }),
    post: a.State(':id', {
      enter: (params) => { 
        if (!Router.isFirstTransition()) getPost(params.id)
      }
      // exit: () => console.log('leave post')
    })
  }),
  tag: a.State('tag/:id', {
    enter: (params) => { 
      if (!Router.isFirstTransition()) getTag(params.id)
    }
    // exit: () => console.log('leave tag')
  }),
  author: a.State('author/:id', {
    enter: (params) => { 
      if (!Router.isFirstTransition()) getAuthor(params.id)
    }
    // exit: () => console.log('leave author')
  })
});

Router.init();