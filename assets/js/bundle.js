(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){

'use strict';

var EventEmitter = require('events'),
    interceptAnchors = require('./anchors'),
    StateWithParams = require('./StateWithParams'),
    Transition = require('./Transition'),
    util = require('./util'),
    State = require('./State'),
    api = require('./api');

/*
* Create a new Router instance, passing any state defined declaratively.
* More states can be added using addState().
*
* Because a router manages global state (the URL), only one instance of Router
* should be used inside an application.
*/
function Router(declarativeStates) {
  var router = {},
      states = stateTrees(declarativeStates),
      firstTransition = true,
      options = {
    enableLogs: false,
    interceptAnchors: true,
    notFound: null,
    urlSync: true,
    hashPrefix: ''
  },
      ignoreNextURLChange = false,
      currentPathQuery,
      currentParamsDiff = {},
      currentState,
      previousState,
      transition,
      leafStates,
      urlChanged,
      initialized,
      hashSlashString;

  /*
  * Setting a new state will start a transition from the current state to the target state.
  * A successful transition will result in the URL being changed.
  * A failed transition will leave the router in its current state.
  */
  function setState(state, params, acc) {
    var fromState = transition ? StateWithParams(transition.currentState, transition.toParams) : currentState;

    var toState = StateWithParams(state, params);
    var diff = util.objectDiff(fromState && fromState.params, params);

    if (preventTransition(fromState, toState, diff)) {
      if (transition && transition.exiting) cancelTransition();
      return;
    }

    if (transition) cancelTransition();

    // While the transition is running, any code asking the router about the previous/current state should
    // get the end result state.
    previousState = currentState;
    currentState = toState;
    currentParamsDiff = diff;

    transition = Transition(fromState, toState, diff, acc, router, logger);

    startingTransition(fromState, toState);

    // In case of a redirect() called from 'startingTransition', the transition already ended.
    if (transition) transition.run();

    // In case of a redirect() called from the transition itself, the transition already ended
    if (transition) {
      if (transition.cancelled) currentState = fromState;else endingTransition(fromState, toState);
    }

    transition = null;
  }

  function cancelTransition() {
    logger.log('Cancelling existing transition from {0} to {1}', transition.from, transition.to);

    transition.cancel();

    firstTransition = false;
  }

  function startingTransition(fromState, toState) {
    logger.log('Starting transition from {0} to {1}', fromState, toState);

    var from = fromState ? fromState.asPublic : null;
    var to = toState.asPublic;

    router.transition.emit('started', to, from);
  }

  function endingTransition(fromState, toState) {
    if (!urlChanged && !firstTransition) {
      logger.log('Updating URL: {0}', currentPathQuery);
      updateURLFromState(currentPathQuery, document.title, currentPathQuery);
    }

    firstTransition = false;

    logger.log('Transition from {0} to {1} ended', fromState, toState);

    toState.state.lastParams = toState.params;

    var from = fromState ? fromState.asPublic : null;
    var to = toState.asPublic;
    router.transition.emit('ended', to, from);
  }

  function updateURLFromState(state, title, url) {
    if (isHashMode()) {
      ignoreNextURLChange = true;
      location.hash = options.hashPrefix + url;
    } else history.pushState(state, title, url);
  }

  /*
  * Return whether the passed state is the same as the current one;
  * in which case the router can ignore the change.
  */
  function preventTransition(current, newState, diff) {
    if (!current) return false;

    return newState.state == current.state && Object.keys(diff.all).length == 0;
  }

  /*
  * The state wasn't found;
  * Transition to the 'notFound' state if the developer specified it or else throw an error.
  */
  function notFound(state) {
    logger.log('State not found: {0}', state);

    if (options.notFound) return setState(leafStates[options.notFound], {});else throw new Error('State "' + state + '" could not be found');
  }

  /*
  * Configure the router before its initialization.
  * The available options are:
  *   enableLogs: Whether (debug and error) console logs should be enabled. Defaults to false.
  *   interceptAnchors: Whether anchor mousedown/clicks should be intercepted and trigger a state change. Defaults to true.
  *   notFound: The State to enter when no state matching the current path query or name could be found. Defaults to null.
  *   urlSync: How should the router maintain the current state and the url in sync. Defaults to true (history API).
  *   hashPrefix: Customize the hash separator. Set to '!' in order to have a hashbang like '/#!/'. Defaults to empty string.
  */
  function configure(withOptions) {
    util.mergeObjects(options, withOptions);
    return router;
  }

  /*
  * Initialize the router.
  * The router will immediately initiate a transition to, in order of priority:
  * 1) The init state passed as an argument
  * 2) The state captured by the current URL
  */
  function init(initState, initParams) {
    if (options.enableLogs) Router.enableLogs();

    if (options.interceptAnchors) interceptAnchors(router);

    hashSlashString = '#' + options.hashPrefix + '/';

    logger.log('Router init');

    initStates();
    logStateTree();

    initState = initState !== undefined ? initState : urlPathQuery();

    logger.log('Initializing to state {0}', initState || '""');
    transitionTo(initState, initParams);

    listenToURLChanges();

    initialized = true;
    return router;
  }

  /*
  * Remove any possibility of side effect this router instance might cause.
  * Used for testing purposes.
  */
  function terminate() {
    window.onhashchange = null;
    window.onpopstate = null;
  }

  function listenToURLChanges() {

    function onURLChange(evt) {
      if (ignoreNextURLChange) {
        ignoreNextURLChange = false;
        return;
      }

      var newState = evt.state || urlPathQuery();

      logger.log('URL changed: {0}', newState);
      urlChanged = true;
      setStateForPathQuery(newState);
    }

    window[isHashMode() ? 'onhashchange' : 'onpopstate'] = onURLChange;
  }

  function initStates() {
    var stateArray = util.objectToArray(states);

    addDefaultStates(stateArray);

    eachRootState(function (name, state) {
      state.init(router, name);
    });

    assertPathUniqueness(stateArray);

    leafStates = registerLeafStates(stateArray, {});

    assertNoAmbiguousPaths();
  }

  function assertPathUniqueness(states) {
    var paths = {};

    states.forEach(function (state) {
      if (paths[state.path]) {
        var fullPaths = states.map(function (s) {
          return s.fullPath() || 'empty';
        });
        throw new Error('Two sibling states have the same path (' + fullPaths + ')');
      }

      paths[state.path] = 1;
      assertPathUniqueness(state.children);
    });
  }

  function assertNoAmbiguousPaths() {
    var paths = {};

    for (var name in leafStates) {
      var path = util.normalizePathQuery(leafStates[name].fullPath());
      if (paths[path]) throw new Error('Ambiguous state paths: ' + path);
      paths[path] = 1;
    }
  }

  function addDefaultStates(states) {
    states.forEach(function (state) {
      var children = util.objectToArray(state.states);

      // This is a parent state: Add a default state to it if there isn't already one
      if (children.length) {
        addDefaultStates(children);

        var hasDefaultState = children.reduce(function (result, state) {
          return state.path == '' || result;
        }, false);

        if (hasDefaultState) return;

        var defaultState = State({ uri: '' });
        state.states._default_ = defaultState;
      }
    });
  }

  function eachRootState(callback) {
    for (var name in states) callback(name, states[name]);
  }

  function registerLeafStates(states, leafStates) {
    return states.reduce(function (leafStates, state) {
      if (state.children.length) return registerLeafStates(state.children, leafStates);else {
        leafStates[state.fullName] = state;
        state.paths = util.parsePaths(state.fullPath());
        return leafStates;
      }
    }, leafStates);
  }

  /*
  * Request a programmatic state change.
  *
  * Two notations are supported:
  * transitionTo('my.target.state', {id: 33, filter: 'desc'})
  * transitionTo('target/33?filter=desc')
  */
  function transitionTo(pathQueryOrName) {
    var name = leafStates[pathQueryOrName];
    var params = (name ? arguments[1] : null) || {};
    var acc = name ? arguments[2] : arguments[1];

    logger.log('Changing state to {0}', pathQueryOrName || '""');

    urlChanged = false;

    if (name) setStateByName(name, params, acc);else setStateForPathQuery(pathQueryOrName, acc);
  }

  /*
  * Attempt to navigate to 'stateName' with its previous params or
  * fallback to the defaultParams parameter if the state was never entered.
  */
  function backTo(stateName, defaultParams, acc) {
    var params = leafStates[stateName].lastParams || defaultParams;
    transitionTo(stateName, params, acc);
  }

  function setStateForPathQuery(pathQuery, acc) {
    var state, params, _state, _params;

    currentPathQuery = util.normalizePathQuery(pathQuery);

    var pq = currentPathQuery.split('?');
    var path = pq[0];
    var query = pq[1];
    var paths = util.parsePaths(path);
    var queryParams = util.parseQueryParams(query);

    for (var name in leafStates) {
      _state = leafStates[name];
      _params = _state.matches(paths);

      if (_params) {
        state = _state;
        params = util.mergeObjects(_params, queryParams);
        break;
      }
    }

    if (state) setState(state, params, acc);else notFound(currentPathQuery);
  }

  function setStateByName(name, params, acc) {
    var state = leafStates[name];

    if (!state) return notFound(name);

    var pathQuery = interpolate(state, params);
    setStateForPathQuery(pathQuery, acc);
  }

  /*
  * Add a new root state to the router.
  * The name must be unique among root states.
  */
  function addState(name, state) {
    if (states[name]) throw new Error('A state already exist in the router with the name ' + name);

    state = stateTree(state);

    states[name] = state;

    if (initialized) {
      state.init(router, name);
      registerLeafStates({ _: state });
    }

    return router;
  }

  /*
  * Read the path/query from the URL.
  */
  function urlPathQuery() {
    var hashSlash = location.href.indexOf(hashSlashString);
    var pathQuery;

    if (hashSlash > -1) pathQuery = location.href.slice(hashSlash + hashSlashString.length);else if (isHashMode()) pathQuery = '/';else pathQuery = (location.pathname + location.search).slice(1);

    return util.normalizePathQuery(pathQuery);
  }

  function isHashMode() {
    return options.urlSync == 'hash';
  }

  /*
  * Compute a link that can be used in anchors' href attributes
  * from a state name and a list of params, a.k.a reverse routing.
  */
  function link(stateName, params) {
    var state = leafStates[stateName];
    if (!state) throw new Error('Cannot find state ' + stateName);

    var interpolated = interpolate(state, params);
    var uri = util.normalizePathQuery(interpolated);

    return isHashMode() ? '#' + options.hashPrefix + uri : uri;
  }

  function interpolate(state, params) {
    var encodedParams = {};

    for (var key in params) {
      encodedParams[key] = encodeURIComponent(params[key]);
    }

    return state.interpolate(encodedParams);
  }

  /*
  * Returns an object representing the current state of the router.
  */
  function getCurrent() {
    return currentState && currentState.asPublic;
  }

  /*
  * Returns an object representing the previous state of the router
  * or null if the router is still in its initial state.
  */
  function getPrevious() {
    return previousState && previousState.asPublic;
  }

  /*
  * Returns the diff between the current params and the previous ones.
  */
  function getParamsDiff() {
    return currentParamsDiff;
  }

  function allStatesRec(states, acc) {
    acc.push.apply(acc, states);
    states.forEach(function (state) {
      return allStatesRec(state.children, acc);
    });
    return acc;
  }

  function allStates() {
    return allStatesRec(util.objectToArray(states), []);
  }

  /*
  * Returns the state object that was built with the given options object or that has the given fullName.
  * Returns undefined if the state doesn't exist.
  */
  function findState(by) {
    var filterFn = typeof by === 'object' ? function (state) {
      return by === state.options;
    } : function (state) {
      return by === state.fullName;
    };

    var state = allStates().filter(filterFn)[0];
    return state && state.asPublic;
  }

  /*
  * Returns whether the router is executing its first transition.
  */
  function isFirstTransition() {
    return previousState == null;
  }

  function stateTrees(states) {
    return util.mapValues(states, stateTree);
  }

  /*
  * Creates an internal State object from a specification POJO.
  */
  function stateTree(state) {
    if (state.children) state.children = stateTrees(state.children);
    return State(state);
  }

  function logStateTree() {
    if (!logger.enabled) return;

    var indent = function indent(level) {
      if (level == 0) return '';
      return new Array(2 + (level - 1) * 4).join(' ') + '── ';
    };

    var stateTree = function stateTree(state) {
      var path = util.normalizePathQuery(state.fullPath());
      var pathStr = state.children.length == 0 ? ' (@ path)'.replace('path', path) : '';
      var str = indent(state.parents.length) + state.name + pathStr + '\n';
      return str + state.children.map(stateTree).join('');
    };

    var msg = '\nState tree\n\n';
    msg += util.objectToArray(states).map(stateTree).join('');
    msg += '\n';

    logger.log(msg);
  }

  // Public methods

  router.configure = configure;
  router.init = init;
  router.transitionTo = transitionTo;
  router.backTo = backTo;
  router.addState = addState;
  router.link = link;
  router.current = getCurrent;
  router.previous = getPrevious;
  router.findState = findState;
  router.isFirstTransition = isFirstTransition;
  router.paramsDiff = getParamsDiff;
  router.options = options;

  router.transition = new EventEmitter();

  // Used for testing purposes only
  router.urlPathQuery = urlPathQuery;
  router.terminate = terminate;

  util.mergeObjects(api, router);

  return router;
}

// Logging

var logger = {
  log: util.noop,
  error: util.noop,
  enabled: false
};

Router.enableLogs = function () {
  logger.enabled = true;

  logger.log = function () {
    for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    var message = util.makeMessage.apply(null, args);
    console.log(message);
  };

  logger.error = function () {
    for (var _len2 = arguments.length, args = Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
      args[_key2] = arguments[_key2];
    }

    var message = util.makeMessage.apply(null, args);
    console.error(message);
  };
};

module.exports = Router;
},{"./State":2,"./StateWithParams":3,"./Transition":4,"./anchors":5,"./api":6,"./util":9,"events":10}],2:[function(require,module,exports){

'use strict';

var util = require('./util');

var PARAMS = /:[^\\?\/]*/g;

/*
* Creates a new State instance from a {uri, enter, exit, update, data, children} object.
* This is the internal representation of a state used by the router.
*/
function State(options) {
  var state = { options: options },
      states = options.children;

  state.path = pathFromURI(options.uri);
  state.params = paramsFromURI(options.uri);
  state.queryParams = queryParamsFromURI(options.uri);
  state.states = states;

  state.enter = options.enter || util.noop;
  state.update = options.update;
  state.exit = options.exit || util.noop;

  state.ownData = options.data || {};

  /*
  * Initialize and freeze this state.
  */
  function init(router, name, parent) {
    state.router = router;
    state.name = name;
    state.isDefault = name == '_default_';
    state.parent = parent;
    state.parents = getParents();
    state.root = state.parent ? state.parents[state.parents.length - 1] : state;
    state.children = util.objectToArray(states);
    state.fullName = getFullName();
    state.asPublic = makePublicAPI();

    eachChildState(function (name, childState) {
      childState.init(router, name, state);
    });
  }

  /*
  * The full path, composed of all the individual paths of this state and its parents.
  */
  function fullPath() {
    var result = state.path,
        stateParent = state.parent;

    while (stateParent) {
      if (stateParent.path) result = stateParent.path + '/' + result;
      stateParent = stateParent.parent;
    }

    return result;
  }

  /*
  * The list of all parents, starting from the closest ones.
  */
  function getParents() {
    var parents = [],
        parent = state.parent;

    while (parent) {
      parents.push(parent);
      parent = parent.parent;
    }

    return parents;
  }

  /*
  * The fully qualified name of this state.
  * e.g granparentName.parentName.name
  */
  function getFullName() {
    var result = state.parents.reduceRight(function (acc, parent) {
      return acc + parent.name + '.';
    }, '') + state.name;

    return state.isDefault ? result.replace('._default_', '') : result;
  }

  function allQueryParams() {
    return state.parents.reduce(function (acc, parent) {
      return util.mergeObjects(acc, parent.queryParams);
    }, util.copyObject(state.queryParams));
  }

  /*
  * Get or Set some arbitrary data by key on this state.
  * child states have access to their parents' data.
  *
  * This can be useful when using external models/services
  * as a mean to communicate between states is not desired.
  */
  function data(key, value) {
    if (value !== undefined) {
      state.ownData[key] = value;
      return state;
    }

    var currentState = state;

    while (currentState.ownData[key] === undefined && currentState.parent) currentState = currentState.parent;

    return currentState.ownData[key];
  }

  function makePublicAPI() {
    return {
      name: state.name,
      fullName: state.fullName,
      parent: state.parent && state.parent.asPublic,
      data: data
    };
  }

  function eachChildState(callback) {
    for (var name in states) callback(name, states[name]);
  }

  /*
  * Returns whether this state matches the passed path Array.
  * In case of a match, the actual param values are returned.
  */
  function matches(paths) {
    var params = {};
    var nonRestStatePaths = state.paths.filter(function (p) {
      return p[p.length - 1] != '*';
    });

    /* This state has more paths than the passed paths, it cannot be a match */
    if (nonRestStatePaths.length > paths.length) return false;

    /* Checks if the paths match one by one */
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      var thatPath = state.paths[i];

      /* This state has less paths than the passed paths, it cannot be a match */
      if (!thatPath) return false;

      var isRest = thatPath[thatPath.length - 1] == '*';
      if (isRest) {
        var name = paramName(thatPath);
        params[name] = paths.slice(i).join('/');
        return params;
      }

      var isDynamic = thatPath[0] == ':';
      if (isDynamic) {
        var name = paramName(thatPath);
        params[name] = path;
      } else if (thatPath != path) return false;
    }

    return params;
  }

  /*
  * Returns a URI built from this state and the passed params.
  */
  function interpolate(params) {
    var path = state.fullPath().replace(PARAMS, function (p) {
      return params[paramName(p)] || '';
    });

    var queryParams = allQueryParams();
    var passedQueryParams = Object.keys(params).filter(function (p) {
      return queryParams[p];
    });

    var query = passedQueryParams.map(function (p) {
      return p + '=' + params[p];
    }).join('&');

    return path + (query.length ? '?' + query : '');
  }

  function toString() {
    return state.fullName;
  }

  state.init = init;
  state.fullPath = fullPath;
  state.allQueryParams = allQueryParams;
  state.matches = matches;
  state.interpolate = interpolate;
  state.data = data;
  state.toString = toString;

  return state;
}

function paramName(param) {
  return param[param.length - 1] == '*' ? param.substr(1).slice(0, -1) : param.substr(1);
}

function pathFromURI(uri) {
  return (uri || '').split('?')[0];
}

function paramsFromURI(uri) {
  var matches = PARAMS.exec(uri);
  return matches ? util.arrayToObject(matches.map(paramName)) : {};
}

function queryParamsFromURI(uri) {
  var query = (uri || '').split('?')[1];
  return query ? util.arrayToObject(query.split('&')) : {};
}

module.exports = State;
},{"./util":9}],3:[function(require,module,exports){

'use strict';

/*
* Creates a new StateWithParams instance.
*
* StateWithParams is the merge between a State object (created and added to the router before init)
* and params (both path and query params, extracted from the URL after init)
*
* This is an internal model; The public model is the asPublic property.
*/
function StateWithParams(state, params, pathQuery) {
  return {
    state: state,
    params: params,
    toString: toString,
    asPublic: makePublicAPI(state, params, pathQuery)
  };
}

function makePublicAPI(state, params, pathQuery) {

  /*
  * Returns whether this state or any of its parents has the given fullName.
  */
  function isIn(fullStateName) {
    var current = state;
    while (current) {
      if (current.fullName == fullStateName) return true;
      current = current.parent;
    }
    return false;
  }

  return {
    uri: pathQuery,
    params: params,
    name: state ? state.name : '',
    fullName: state ? state.fullName : '',
    data: state ? state.data : null,
    isIn: isIn
  };
}

function toString() {
  var name = this.state && this.state.fullName;
  return name + ':' + JSON.stringify(this.params);
}

module.exports = StateWithParams;
},{}],4:[function(require,module,exports){

'use strict';

/*
* Create a new Transition instance.
*/
function Transition(fromStateWithParams, toStateWithParams, paramsDiff, acc, router, logger) {
  var root, enters, exits;

  var fromState = fromStateWithParams && fromStateWithParams.state;
  var toState = toStateWithParams.state;
  var params = toStateWithParams.params;
  var isUpdate = fromState == toState;

  var transition = {
    from: fromState,
    to: toState,
    toParams: params,
    cancel: cancel,
    cancelled: false,
    currentState: fromState,
    run: run
  };

  // The first transition has no fromState.
  if (fromState) root = transitionRoot(fromState, toState, isUpdate, paramsDiff);

  var inclusive = !root || isUpdate;
  exits = fromState ? transitionStates(fromState, root, inclusive) : [];
  enters = transitionStates(toState, root, inclusive).reverse();

  function run() {
    startTransition(enters, exits, params, transition, isUpdate, acc, router, logger);
  }

  function cancel() {
    transition.cancelled = true;
  }

  return transition;
}

function startTransition(enters, exits, params, transition, isUpdate, acc, router, logger) {
  acc = acc || {};

  transition.exiting = true;
  exits.forEach(function (state) {
    if (isUpdate && state.update) return;
    runStep(state, 'exit', params, transition, acc, router, logger);
  });
  transition.exiting = false;

  enters.forEach(function (state) {
    var fn = isUpdate && state.update ? 'update' : 'enter';
    runStep(state, fn, params, transition, acc, router, logger);
  });
}

function runStep(state, stepFn, params, transition, acc, router, logger) {
  if (transition.cancelled) return;

  if (logger.enabled) {
    var capitalizedStep = stepFn[0].toUpperCase() + stepFn.slice(1);
    logger.log(capitalizedStep + ' ' + state.fullName);
  }

  var result = state[stepFn](params, acc, router);

  if (transition.cancelled) return;

  transition.currentState = stepFn == 'exit' ? state.parent : state;

  return result;
}

/*
* The top-most current state's parent that must be exited.
*/
function transitionRoot(fromState, toState, isUpdate, paramsDiff) {
  var root, parent, param;

  // For a param-only change, the root is the top-most state owning the param(s),
  if (isUpdate) {
    [fromState].concat(fromState.parents).reverse().forEach(function (parent) {
      if (root) return;

      for (param in paramsDiff.all) {
        if (parent.params[param] || parent.queryParams[param]) {
          root = parent;
          break;
        }
      }
    });
  }
  // Else, the root is the closest common parent of the two states.
  else {
      for (var i = 0; i < fromState.parents.length; i++) {
        parent = fromState.parents[i];
        if (toState.parents.indexOf(parent) > -1) {
          root = parent;
          break;
        }
      }
    }

  return root;
}

function transitionStates(state, root, inclusive) {
  root = root || state.root;

  var p = state.parents,
      end = Math.min(p.length, p.indexOf(root) + (inclusive ? 1 : 0));

  return [state].concat(p.slice(0, end));
}

module.exports = Transition;
},{}],5:[function(require,module,exports){

'use strict';

var router;

function onMouseDown(evt) {
  var href = hrefForEvent(evt);

  if (href !== undefined) router.transitionTo(href);
}

function onMouseClick(evt) {
  var href = hrefForEvent(evt);

  if (href !== undefined) {
    evt.preventDefault();

    router.transitionTo(href);
  }
}

function hrefForEvent(evt) {
  if (evt.defaultPrevented || evt.metaKey || evt.ctrlKey || !isLeftButton(evt)) return;

  var target = evt.target;
  var anchor = anchorTarget(target);
  if (!anchor) return;

  var dataNav = anchor.getAttribute('data-nav');

  if (dataNav == 'ignore') return;
  if (evt.type == 'mousedown' && dataNav != 'mousedown') return;

  var href = anchor.getAttribute('href');

  if (!href) return;
  if (href.charAt(0) == '#') {
    if (router.options.urlSync != 'hash') return;
    href = href.slice(1);
  }
  if (anchor.getAttribute('target') == '_blank') return;
  if (!isLocalLink(anchor)) return;

  // At this point, we have a valid href to follow.
  // Did the navigation already occur on mousedown though?
  if (evt.type == 'click' && dataNav == 'mousedown') {
    evt.preventDefault();
    return;
  }

  return href;
}

function isLeftButton(evt) {
  return evt.which == 1;
}

function anchorTarget(target) {
  while (target) {
    if (target.nodeName == 'A') return target;
    target = target.parentNode;
  }
}

function isLocalLink(anchor) {
  var hostname = anchor.hostname;
  var port = anchor.port;

  // IE10 can lose the hostname/port property when setting a relative href from JS
  if (!hostname) {
    var tempAnchor = document.createElement("a");
    tempAnchor.href = anchor.href;
    hostname = tempAnchor.hostname;
    port = tempAnchor.port;
  }

  var sameHostname = hostname == location.hostname;
  var samePort = (port || '80') == (location.port || '80');

  return sameHostname && samePort;
}

module.exports = function interceptAnchors(forRouter) {
  router = forRouter;

  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('click', onMouseClick);
};
},{}],6:[function(require,module,exports){

/* Represents the public API of the last instanciated router; Useful to break circular dependencies between router and its states */
"use strict";

module.exports = {};
},{}],7:[function(require,module,exports){
'use strict';

var api = require('./api');

/* Wraps a thennable/promise and only resolve it if the router didn't transition to another state in the meantime */
function async(wrapped) {
  var PromiseImpl = async.Promise || Promise;
  var fire = true;

  api.transition.once('started', function () {
    fire = false;
  });

  var promise = new PromiseImpl(function (resolve, reject) {
    wrapped.then(function (value) {
      if (fire) resolve(value);
    }, function (err) {
      if (fire) reject(err);
    });
  });

  return promise;
};

module.exports = async;
},{"./api":6}],8:[function(require,module,exports){

'use strict';

var util = require('./util');

var Abyssa = {
  Router: require('./Router'),
  api: require('./api'),
  async: require('./async'),
  State: util.stateShorthand,

  _util: util
};

module.exports = Abyssa;
},{"./Router":1,"./api":6,"./async":7,"./util":9}],9:[function(require,module,exports){

'use strict';

var util = {};

util.noop = function () {};

util.arrayToObject = function (array) {
  return array.reduce(function (obj, item) {
    obj[item] = 1;
    return obj;
  }, {});
};

util.objectToArray = function (obj) {
  var array = [];
  for (var key in obj) array.push(obj[key]);
  return array;
};

util.copyObject = function (obj) {
  var copy = {};
  for (var key in obj) copy[key] = obj[key];
  return copy;
};

util.mergeObjects = function (to, from) {
  for (var key in from) to[key] = from[key];
  return to;
};

util.mapValues = function (obj, fn) {
  var result = {};
  for (var key in obj) {
    result[key] = fn(obj[key]);
  }
  return result;
};

/*
* Return the set of all the keys that changed (either added, removed or modified).
*/
util.objectDiff = function (obj1, obj2) {
  var update = {},
      enter = {},
      exit = {},
      all = {},
      name,
      obj1 = obj1 || {};

  for (name in obj1) {
    if (!(name in obj2)) exit[name] = all[name] = true;else if (obj1[name] != obj2[name]) update[name] = all[name] = true;
  }

  for (name in obj2) {
    if (!(name in obj1)) enter[name] = all[name] = true;
  }

  return { all: all, update: update, enter: enter, exit: exit };
};

util.makeMessage = function () {
  var message = arguments[0],
      tokens = Array.prototype.slice.call(arguments, 1);

  for (var i = 0, l = tokens.length; i < l; i++) message = message.replace('{' + i + '}', tokens[i]);

  return message;
};

util.parsePaths = function (path) {
  return path.split('/').filter(function (str) {
    return str.length;
  }).map(function (str) {
    return decodeURIComponent(str);
  });
};

util.parseQueryParams = function (query) {
  return query ? query.split('&').reduce(function (res, paramValue) {
    var pv = paramValue.split('=');
    res[pv[0]] = decodeURIComponent(pv[1]);
    return res;
  }, {}) : {};
};

var LEADING_SLASHES = /^\/+/;
var TRAILING_SLASHES = /^([^?]*?)\/+$/;
var TRAILING_SLASHES_BEFORE_QUERY = /\/+\?/;
util.normalizePathQuery = function (pathQuery) {
  return '/' + pathQuery.replace(LEADING_SLASHES, '').replace(TRAILING_SLASHES, '$1').replace(TRAILING_SLASHES_BEFORE_QUERY, '?');
};

util.stateShorthand = function (uri, options, children) {
  return util.mergeObjects({ uri: uri, children: children || {} }, options);
};

module.exports = util;
},{}],10:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      }
      throw TypeError('Uncaught, unspecified "error" event.');
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        len = arguments.length;
        args = new Array(len - 1);
        for (i = 1; i < len; i++)
          args[i - 1] = arguments[i];
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    len = arguments.length;
    args = new Array(len - 1);
    for (i = 1; i < len; i++)
      args[i - 1] = arguments[i];

    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    var m;
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.listenerCount = function(emitter, type) {
  var ret;
  if (!emitter._events || !emitter._events[type])
    ret = 0;
  else if (isFunction(emitter._events[type]))
    ret = 1;
  else
    ret = emitter._events[type].length;
  return ret;
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],11:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.getHome = getHome;
exports.getPost = getPost;
exports.getTag = getTag;
exports.getAuthor = getAuthor;

var _domJs = require('./dom.js');

function ajax(url) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();

    xhr.open('GET', window.location.origin + url);
    xhr.onload = function () {
      if (xhr.status == 200) resolve((0, _domJs.parseHTML)(xhr.responseText));else reject(Error(xhr.statusText));
    };
    xhr.onerror = function () {
      reject(Error('Network Error'));
    };
    xhr.send();
  });
}

function getHome() {
  ajax('/').then(function (res) {
    return (0, _domJs.loadPage)(res);
  });
}

function getPost(id) {
  ajax('/' + id).then(function (res) {
    return (0, _domJs.loadPage)(res);
  });
}

function getTag(id) {
  ajax('/tag/' + id).then(function (res) {
    return (0, _domJs.loadPage)(res);
  });
}

function getAuthor(id) {
  ajax('/author/' + id).then(function (res) {
    return (0, _domJs.loadPage)(res);
  });
}

},{"./dom.js":12}],12:[function(require,module,exports){

// Get parsed html from xhr
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.parseHTML = parseHTML;
exports.loadPage = loadPage;

function parseHTML(str) {
  var tmpXML = document.implementation.createHTMLDocument();
  tmpXML.body.innerHTML = str;
  var bodyXML = tmpXML.body.children;

  for (var i in bodyXML) {
    var $wrap = bodyXML[i].querySelector('#wrap');
    if ($wrap !== null) return $wrap;
  }
}

// Inject element's html in wrapper

function loadPage(element) {
  document.querySelector('#content').innerHTML = element.innerHTML;
}

},{}],13:[function(require,module,exports){
'use strict';

function _interopRequireDefault(obj) {
  return obj && obj.__esModule ? obj : { 'default': obj };
}

var _abyssa = require('abyssa');

var _abyssa2 = _interopRequireDefault(_abyssa);

var _utilsAjax = require('./utils/ajax');

var Router = _abyssa2['default'].Router({
  index: _abyssa2['default'].State('/', {
    enter: function enter(params) {
      if (!Router.isFirstTransition()) console.log('test');
    }
    // exit: () => console.log('leave home')
  }, {
    home: _abyssa2['default'].State('', {
      enter: function enter(params) {
        if (!Router.isFirstTransition()) (0, _utilsAjax.getHome)();
      }
      // exit: () => console.log('leave home')
    }),
    post: _abyssa2['default'].State(':id', {
      enter: function enter(params) {
        if (!Router.isFirstTransition()) (0, _utilsAjax.getPost)(params.id);
      }
      // exit: () => console.log('leave post')
    })
  }),
  tag: _abyssa2['default'].State('tag/:id', {
    enter: function enter(params) {
      if (!Router.isFirstTransition()) (0, _utilsAjax.getTag)(params.id);
    }
    // exit: () => console.log('leave tag')
  }),
  author: _abyssa2['default'].State('author/:id', {
    enter: function enter(params) {
      if (!Router.isFirstTransition()) (0, _utilsAjax.getAuthor)(params.id);
    }
    // exit: () => console.log('leave author')
  })
});

Router.init();

},{"./utils/ajax":11,"abyssa":8}]},{},[13])
//# sourceMappingURL=data:application/json;charset:utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJub2RlX21vZHVsZXMvYWJ5c3NhL2xpYi9Sb3V0ZXIuanMiLCJub2RlX21vZHVsZXMvYWJ5c3NhL2xpYi9TdGF0ZS5qcyIsIm5vZGVfbW9kdWxlcy9hYnlzc2EvbGliL1N0YXRlV2l0aFBhcmFtcy5qcyIsIm5vZGVfbW9kdWxlcy9hYnlzc2EvbGliL1RyYW5zaXRpb24uanMiLCJub2RlX21vZHVsZXMvYWJ5c3NhL2xpYi9hbmNob3JzLmpzIiwibm9kZV9tb2R1bGVzL2FieXNzYS9saWIvYXBpLmpzIiwibm9kZV9tb2R1bGVzL2FieXNzYS9saWIvYXN5bmMuanMiLCJub2RlX21vZHVsZXMvYWJ5c3NhL2xpYi9tYWluLmpzIiwibm9kZV9tb2R1bGVzL2FieXNzYS9saWIvdXRpbC5qcyIsIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9ldmVudHMvZXZlbnRzLmpzIiwiL1VzZXJzL3Riby9Eb2N1bWVudHMvR2l0aHViL2dob3N0LXRoZW1lL2NvbnRlbnQvdGhlbWVzL3N1bnNldC9zcmMvanMvdXRpbHMvYWpheC5qcyIsIi9Vc2Vycy90Ym8vRG9jdW1lbnRzL0dpdGh1Yi9naG9zdC10aGVtZS9jb250ZW50L3RoZW1lcy9zdW5zZXQvc3JjL2pzL3V0aWxzL2RvbS5qcyIsIi9Vc2Vycy90Ym8vRG9jdW1lbnRzL0dpdGh1Yi9naG9zdC10aGVtZS9jb250ZW50L3RoZW1lcy9zdW5zZXQvc3JjL2pzL2luZGV4LmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6aUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDek5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FB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QSxVQUFBLENBQUEsU0FBQSxDQUFBLENBQVUsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFBO0tBQ3REOztHQUVGLENBQUM7Q0FDSCxDQUFDLENBQUM7O0FBRUgsTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIlxuJ3VzZSBzdHJpY3QnO1xuXG52YXIgRXZlbnRFbWl0dGVyID0gcmVxdWlyZSgnZXZlbnRzJyksXG4gICAgaW50ZXJjZXB0QW5jaG9ycyA9IHJlcXVpcmUoJy4vYW5jaG9ycycpLFxuICAgIFN0YXRlV2l0aFBhcmFtcyA9IHJlcXVpcmUoJy4vU3RhdGVXaXRoUGFyYW1zJyksXG4gICAgVHJhbnNpdGlvbiA9IHJlcXVpcmUoJy4vVHJhbnNpdGlvbicpLFxuICAgIHV0aWwgPSByZXF1aXJlKCcuL3V0aWwnKSxcbiAgICBTdGF0ZSA9IHJlcXVpcmUoJy4vU3RhdGUnKSxcbiAgICBhcGkgPSByZXF1aXJlKCcuL2FwaScpO1xuXG4vKlxuKiBDcmVhdGUgYSBuZXcgUm91dGVyIGluc3RhbmNlLCBwYXNzaW5nIGFueSBzdGF0ZSBkZWZpbmVkIGRlY2xhcmF0aXZlbHkuXG4qIE1vcmUgc3RhdGVzIGNhbiBiZSBhZGRlZCB1c2luZyBhZGRTdGF0ZSgpLlxuKlxuKiBCZWNhdXNlIGEgcm91dGVyIG1hbmFnZXMgZ2xvYmFsIHN0YXRlICh0aGUgVVJMKSwgb25seSBvbmUgaW5zdGFuY2Ugb2YgUm91dGVyXG4qIHNob3VsZCBiZSB1c2VkIGluc2lkZSBhbiBhcHBsaWNhdGlvbi5cbiovXG5mdW5jdGlvbiBSb3V0ZXIoZGVjbGFyYXRpdmVTdGF0ZXMpIHtcbiAgdmFyIHJvdXRlciA9IHt9LFxuICAgICAgc3RhdGVzID0gc3RhdGVUcmVlcyhkZWNsYXJhdGl2ZVN0YXRlcyksXG4gICAgICBmaXJzdFRyYW5zaXRpb24gPSB0cnVlLFxuICAgICAgb3B0aW9ucyA9IHtcbiAgICBlbmFibGVMb2dzOiBmYWxzZSxcbiAgICBpbnRlcmNlcHRBbmNob3JzOiB0cnVlLFxuICAgIG5vdEZvdW5kOiBudWxsLFxuICAgIHVybFN5bmM6IHRydWUsXG4gICAgaGFzaFByZWZpeDogJydcbiAgfSxcbiAgICAgIGlnbm9yZU5leHRVUkxDaGFuZ2UgPSBmYWxzZSxcbiAgICAgIGN1cnJlbnRQYXRoUXVlcnksXG4gICAgICBjdXJyZW50UGFyYW1zRGlmZiA9IHt9LFxuICAgICAgY3VycmVudFN0YXRlLFxuICAgICAgcHJldmlvdXNTdGF0ZSxcbiAgICAgIHRyYW5zaXRpb24sXG4gICAgICBsZWFmU3RhdGVzLFxuICAgICAgdXJsQ2hhbmdlZCxcbiAgICAgIGluaXRpYWxpemVkLFxuICAgICAgaGFzaFNsYXNoU3RyaW5nO1xuXG4gIC8qXG4gICogU2V0dGluZyBhIG5ldyBzdGF0ZSB3aWxsIHN0YXJ0IGEgdHJhbnNpdGlvbiBmcm9tIHRoZSBjdXJyZW50IHN0YXRlIHRvIHRoZSB0YXJnZXQgc3RhdGUuXG4gICogQSBzdWNjZXNzZnVsIHRyYW5zaXRpb24gd2lsbCByZXN1bHQgaW4gdGhlIFVSTCBiZWluZyBjaGFuZ2VkLlxuICAqIEEgZmFpbGVkIHRyYW5zaXRpb24gd2lsbCBsZWF2ZSB0aGUgcm91dGVyIGluIGl0cyBjdXJyZW50IHN0YXRlLlxuICAqL1xuICBmdW5jdGlvbiBzZXRTdGF0ZShzdGF0ZSwgcGFyYW1zLCBhY2MpIHtcbiAgICB2YXIgZnJvbVN0YXRlID0gdHJhbnNpdGlvbiA/IFN0YXRlV2l0aFBhcmFtcyh0cmFuc2l0aW9uLmN1cnJlbnRTdGF0ZSwgdHJhbnNpdGlvbi50b1BhcmFtcykgOiBjdXJyZW50U3RhdGU7XG5cbiAgICB2YXIgdG9TdGF0ZSA9IFN0YXRlV2l0aFBhcmFtcyhzdGF0ZSwgcGFyYW1zKTtcbiAgICB2YXIgZGlmZiA9IHV0aWwub2JqZWN0RGlmZihmcm9tU3RhdGUgJiYgZnJvbVN0YXRlLnBhcmFtcywgcGFyYW1zKTtcblxuICAgIGlmIChwcmV2ZW50VHJhbnNpdGlvbihmcm9tU3RhdGUsIHRvU3RhdGUsIGRpZmYpKSB7XG4gICAgICBpZiAodHJhbnNpdGlvbiAmJiB0cmFuc2l0aW9uLmV4aXRpbmcpIGNhbmNlbFRyYW5zaXRpb24oKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAodHJhbnNpdGlvbikgY2FuY2VsVHJhbnNpdGlvbigpO1xuXG4gICAgLy8gV2hpbGUgdGhlIHRyYW5zaXRpb24gaXMgcnVubmluZywgYW55IGNvZGUgYXNraW5nIHRoZSByb3V0ZXIgYWJvdXQgdGhlIHByZXZpb3VzL2N1cnJlbnQgc3RhdGUgc2hvdWxkXG4gICAgLy8gZ2V0IHRoZSBlbmQgcmVzdWx0IHN0YXRlLlxuICAgIHByZXZpb3VzU3RhdGUgPSBjdXJyZW50U3RhdGU7XG4gICAgY3VycmVudFN0YXRlID0gdG9TdGF0ZTtcbiAgICBjdXJyZW50UGFyYW1zRGlmZiA9IGRpZmY7XG5cbiAgICB0cmFuc2l0aW9uID0gVHJhbnNpdGlvbihmcm9tU3RhdGUsIHRvU3RhdGUsIGRpZmYsIGFjYywgcm91dGVyLCBsb2dnZXIpO1xuXG4gICAgc3RhcnRpbmdUcmFuc2l0aW9uKGZyb21TdGF0ZSwgdG9TdGF0ZSk7XG5cbiAgICAvLyBJbiBjYXNlIG9mIGEgcmVkaXJlY3QoKSBjYWxsZWQgZnJvbSAnc3RhcnRpbmdUcmFuc2l0aW9uJywgdGhlIHRyYW5zaXRpb24gYWxyZWFkeSBlbmRlZC5cbiAgICBpZiAodHJhbnNpdGlvbikgdHJhbnNpdGlvbi5ydW4oKTtcblxuICAgIC8vIEluIGNhc2Ugb2YgYSByZWRpcmVjdCgpIGNhbGxlZCBmcm9tIHRoZSB0cmFuc2l0aW9uIGl0c2VsZiwgdGhlIHRyYW5zaXRpb24gYWxyZWFkeSBlbmRlZFxuICAgIGlmICh0cmFuc2l0aW9uKSB7XG4gICAgICBpZiAodHJhbnNpdGlvbi5jYW5jZWxsZWQpIGN1cnJlbnRTdGF0ZSA9IGZyb21TdGF0ZTtlbHNlIGVuZGluZ1RyYW5zaXRpb24oZnJvbVN0YXRlLCB0b1N0YXRlKTtcbiAgICB9XG5cbiAgICB0cmFuc2l0aW9uID0gbnVsbDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNhbmNlbFRyYW5zaXRpb24oKSB7XG4gICAgbG9nZ2VyLmxvZygnQ2FuY2VsbGluZyBleGlzdGluZyB0cmFuc2l0aW9uIGZyb20gezB9IHRvIHsxfScsIHRyYW5zaXRpb24uZnJvbSwgdHJhbnNpdGlvbi50byk7XG5cbiAgICB0cmFuc2l0aW9uLmNhbmNlbCgpO1xuXG4gICAgZmlyc3RUcmFuc2l0aW9uID0gZmFsc2U7XG4gIH1cblxuICBmdW5jdGlvbiBzdGFydGluZ1RyYW5zaXRpb24oZnJvbVN0YXRlLCB0b1N0YXRlKSB7XG4gICAgbG9nZ2VyLmxvZygnU3RhcnRpbmcgdHJhbnNpdGlvbiBmcm9tIHswfSB0byB7MX0nLCBmcm9tU3RhdGUsIHRvU3RhdGUpO1xuXG4gICAgdmFyIGZyb20gPSBmcm9tU3RhdGUgPyBmcm9tU3RhdGUuYXNQdWJsaWMgOiBudWxsO1xuICAgIHZhciB0byA9IHRvU3RhdGUuYXNQdWJsaWM7XG5cbiAgICByb3V0ZXIudHJhbnNpdGlvbi5lbWl0KCdzdGFydGVkJywgdG8sIGZyb20pO1xuICB9XG5cbiAgZnVuY3Rpb24gZW5kaW5nVHJhbnNpdGlvbihmcm9tU3RhdGUsIHRvU3RhdGUpIHtcbiAgICBpZiAoIXVybENoYW5nZWQgJiYgIWZpcnN0VHJhbnNpdGlvbikge1xuICAgICAgbG9nZ2VyLmxvZygnVXBkYXRpbmcgVVJMOiB7MH0nLCBjdXJyZW50UGF0aFF1ZXJ5KTtcbiAgICAgIHVwZGF0ZVVSTEZyb21TdGF0ZShjdXJyZW50UGF0aFF1ZXJ5LCBkb2N1bWVudC50aXRsZSwgY3VycmVudFBhdGhRdWVyeSk7XG4gICAgfVxuXG4gICAgZmlyc3RUcmFuc2l0aW9uID0gZmFsc2U7XG5cbiAgICBsb2dnZXIubG9nKCdUcmFuc2l0aW9uIGZyb20gezB9IHRvIHsxfSBlbmRlZCcsIGZyb21TdGF0ZSwgdG9TdGF0ZSk7XG5cbiAgICB0b1N0YXRlLnN0YXRlLmxhc3RQYXJhbXMgPSB0b1N0YXRlLnBhcmFtcztcblxuICAgIHZhciBmcm9tID0gZnJvbVN0YXRlID8gZnJvbVN0YXRlLmFzUHVibGljIDogbnVsbDtcbiAgICB2YXIgdG8gPSB0b1N0YXRlLmFzUHVibGljO1xuICAgIHJvdXRlci50cmFuc2l0aW9uLmVtaXQoJ2VuZGVkJywgdG8sIGZyb20pO1xuICB9XG5cbiAgZnVuY3Rpb24gdXBkYXRlVVJMRnJvbVN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKSB7XG4gICAgaWYgKGlzSGFzaE1vZGUoKSkge1xuICAgICAgaWdub3JlTmV4dFVSTENoYW5nZSA9IHRydWU7XG4gICAgICBsb2NhdGlvbi5oYXNoID0gb3B0aW9ucy5oYXNoUHJlZml4ICsgdXJsO1xuICAgIH0gZWxzZSBoaXN0b3J5LnB1c2hTdGF0ZShzdGF0ZSwgdGl0bGUsIHVybCk7XG4gIH1cblxuICAvKlxuICAqIFJldHVybiB3aGV0aGVyIHRoZSBwYXNzZWQgc3RhdGUgaXMgdGhlIHNhbWUgYXMgdGhlIGN1cnJlbnQgb25lO1xuICAqIGluIHdoaWNoIGNhc2UgdGhlIHJvdXRlciBjYW4gaWdub3JlIHRoZSBjaGFuZ2UuXG4gICovXG4gIGZ1bmN0aW9uIHByZXZlbnRUcmFuc2l0aW9uKGN1cnJlbnQsIG5ld1N0YXRlLCBkaWZmKSB7XG4gICAgaWYgKCFjdXJyZW50KSByZXR1cm4gZmFsc2U7XG5cbiAgICByZXR1cm4gbmV3U3RhdGUuc3RhdGUgPT0gY3VycmVudC5zdGF0ZSAmJiBPYmplY3Qua2V5cyhkaWZmLmFsbCkubGVuZ3RoID09IDA7XG4gIH1cblxuICAvKlxuICAqIFRoZSBzdGF0ZSB3YXNuJ3QgZm91bmQ7XG4gICogVHJhbnNpdGlvbiB0byB0aGUgJ25vdEZvdW5kJyBzdGF0ZSBpZiB0aGUgZGV2ZWxvcGVyIHNwZWNpZmllZCBpdCBvciBlbHNlIHRocm93IGFuIGVycm9yLlxuICAqL1xuICBmdW5jdGlvbiBub3RGb3VuZChzdGF0ZSkge1xuICAgIGxvZ2dlci5sb2coJ1N0YXRlIG5vdCBmb3VuZDogezB9Jywgc3RhdGUpO1xuXG4gICAgaWYgKG9wdGlvbnMubm90Rm91bmQpIHJldHVybiBzZXRTdGF0ZShsZWFmU3RhdGVzW29wdGlvbnMubm90Rm91bmRdLCB7fSk7ZWxzZSB0aHJvdyBuZXcgRXJyb3IoJ1N0YXRlIFwiJyArIHN0YXRlICsgJ1wiIGNvdWxkIG5vdCBiZSBmb3VuZCcpO1xuICB9XG5cbiAgLypcbiAgKiBDb25maWd1cmUgdGhlIHJvdXRlciBiZWZvcmUgaXRzIGluaXRpYWxpemF0aW9uLlxuICAqIFRoZSBhdmFpbGFibGUgb3B0aW9ucyBhcmU6XG4gICogICBlbmFibGVMb2dzOiBXaGV0aGVyIChkZWJ1ZyBhbmQgZXJyb3IpIGNvbnNvbGUgbG9ncyBzaG91bGQgYmUgZW5hYmxlZC4gRGVmYXVsdHMgdG8gZmFsc2UuXG4gICogICBpbnRlcmNlcHRBbmNob3JzOiBXaGV0aGVyIGFuY2hvciBtb3VzZWRvd24vY2xpY2tzIHNob3VsZCBiZSBpbnRlcmNlcHRlZCBhbmQgdHJpZ2dlciBhIHN0YXRlIGNoYW5nZS4gRGVmYXVsdHMgdG8gdHJ1ZS5cbiAgKiAgIG5vdEZvdW5kOiBUaGUgU3RhdGUgdG8gZW50ZXIgd2hlbiBubyBzdGF0ZSBtYXRjaGluZyB0aGUgY3VycmVudCBwYXRoIHF1ZXJ5IG9yIG5hbWUgY291bGQgYmUgZm91bmQuIERlZmF1bHRzIHRvIG51bGwuXG4gICogICB1cmxTeW5jOiBIb3cgc2hvdWxkIHRoZSByb3V0ZXIgbWFpbnRhaW4gdGhlIGN1cnJlbnQgc3RhdGUgYW5kIHRoZSB1cmwgaW4gc3luYy4gRGVmYXVsdHMgdG8gdHJ1ZSAoaGlzdG9yeSBBUEkpLlxuICAqICAgaGFzaFByZWZpeDogQ3VzdG9taXplIHRoZSBoYXNoIHNlcGFyYXRvci4gU2V0IHRvICchJyBpbiBvcmRlciB0byBoYXZlIGEgaGFzaGJhbmcgbGlrZSAnLyMhLycuIERlZmF1bHRzIHRvIGVtcHR5IHN0cmluZy5cbiAgKi9cbiAgZnVuY3Rpb24gY29uZmlndXJlKHdpdGhPcHRpb25zKSB7XG4gICAgdXRpbC5tZXJnZU9iamVjdHMob3B0aW9ucywgd2l0aE9wdGlvbnMpO1xuICAgIHJldHVybiByb3V0ZXI7XG4gIH1cblxuICAvKlxuICAqIEluaXRpYWxpemUgdGhlIHJvdXRlci5cbiAgKiBUaGUgcm91dGVyIHdpbGwgaW1tZWRpYXRlbHkgaW5pdGlhdGUgYSB0cmFuc2l0aW9uIHRvLCBpbiBvcmRlciBvZiBwcmlvcml0eTpcbiAgKiAxKSBUaGUgaW5pdCBzdGF0ZSBwYXNzZWQgYXMgYW4gYXJndW1lbnRcbiAgKiAyKSBUaGUgc3RhdGUgY2FwdHVyZWQgYnkgdGhlIGN1cnJlbnQgVVJMXG4gICovXG4gIGZ1bmN0aW9uIGluaXQoaW5pdFN0YXRlLCBpbml0UGFyYW1zKSB7XG4gICAgaWYgKG9wdGlvbnMuZW5hYmxlTG9ncykgUm91dGVyLmVuYWJsZUxvZ3MoKTtcblxuICAgIGlmIChvcHRpb25zLmludGVyY2VwdEFuY2hvcnMpIGludGVyY2VwdEFuY2hvcnMocm91dGVyKTtcblxuICAgIGhhc2hTbGFzaFN0cmluZyA9ICcjJyArIG9wdGlvbnMuaGFzaFByZWZpeCArICcvJztcblxuICAgIGxvZ2dlci5sb2coJ1JvdXRlciBpbml0Jyk7XG5cbiAgICBpbml0U3RhdGVzKCk7XG4gICAgbG9nU3RhdGVUcmVlKCk7XG5cbiAgICBpbml0U3RhdGUgPSBpbml0U3RhdGUgIT09IHVuZGVmaW5lZCA/IGluaXRTdGF0ZSA6IHVybFBhdGhRdWVyeSgpO1xuXG4gICAgbG9nZ2VyLmxvZygnSW5pdGlhbGl6aW5nIHRvIHN0YXRlIHswfScsIGluaXRTdGF0ZSB8fCAnXCJcIicpO1xuICAgIHRyYW5zaXRpb25Ubyhpbml0U3RhdGUsIGluaXRQYXJhbXMpO1xuXG4gICAgbGlzdGVuVG9VUkxDaGFuZ2VzKCk7XG5cbiAgICBpbml0aWFsaXplZCA9IHRydWU7XG4gICAgcmV0dXJuIHJvdXRlcjtcbiAgfVxuXG4gIC8qXG4gICogUmVtb3ZlIGFueSBwb3NzaWJpbGl0eSBvZiBzaWRlIGVmZmVjdCB0aGlzIHJvdXRlciBpbnN0YW5jZSBtaWdodCBjYXVzZS5cbiAgKiBVc2VkIGZvciB0ZXN0aW5nIHB1cnBvc2VzLlxuICAqL1xuICBmdW5jdGlvbiB0ZXJtaW5hdGUoKSB7XG4gICAgd2luZG93Lm9uaGFzaGNoYW5nZSA9IG51bGw7XG4gICAgd2luZG93Lm9ucG9wc3RhdGUgPSBudWxsO1xuICB9XG5cbiAgZnVuY3Rpb24gbGlzdGVuVG9VUkxDaGFuZ2VzKCkge1xuXG4gICAgZnVuY3Rpb24gb25VUkxDaGFuZ2UoZXZ0KSB7XG4gICAgICBpZiAoaWdub3JlTmV4dFVSTENoYW5nZSkge1xuICAgICAgICBpZ25vcmVOZXh0VVJMQ2hhbmdlID0gZmFsc2U7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgdmFyIG5ld1N0YXRlID0gZXZ0LnN0YXRlIHx8IHVybFBhdGhRdWVyeSgpO1xuXG4gICAgICBsb2dnZXIubG9nKCdVUkwgY2hhbmdlZDogezB9JywgbmV3U3RhdGUpO1xuICAgICAgdXJsQ2hhbmdlZCA9IHRydWU7XG4gICAgICBzZXRTdGF0ZUZvclBhdGhRdWVyeShuZXdTdGF0ZSk7XG4gICAgfVxuXG4gICAgd2luZG93W2lzSGFzaE1vZGUoKSA/ICdvbmhhc2hjaGFuZ2UnIDogJ29ucG9wc3RhdGUnXSA9IG9uVVJMQ2hhbmdlO1xuICB9XG5cbiAgZnVuY3Rpb24gaW5pdFN0YXRlcygpIHtcbiAgICB2YXIgc3RhdGVBcnJheSA9IHV0aWwub2JqZWN0VG9BcnJheShzdGF0ZXMpO1xuXG4gICAgYWRkRGVmYXVsdFN0YXRlcyhzdGF0ZUFycmF5KTtcblxuICAgIGVhY2hSb290U3RhdGUoZnVuY3Rpb24gKG5hbWUsIHN0YXRlKSB7XG4gICAgICBzdGF0ZS5pbml0KHJvdXRlciwgbmFtZSk7XG4gICAgfSk7XG5cbiAgICBhc3NlcnRQYXRoVW5pcXVlbmVzcyhzdGF0ZUFycmF5KTtcblxuICAgIGxlYWZTdGF0ZXMgPSByZWdpc3RlckxlYWZTdGF0ZXMoc3RhdGVBcnJheSwge30pO1xuXG4gICAgYXNzZXJ0Tm9BbWJpZ3VvdXNQYXRocygpO1xuICB9XG5cbiAgZnVuY3Rpb24gYXNzZXJ0UGF0aFVuaXF1ZW5lc3Moc3RhdGVzKSB7XG4gICAgdmFyIHBhdGhzID0ge307XG5cbiAgICBzdGF0ZXMuZm9yRWFjaChmdW5jdGlvbiAoc3RhdGUpIHtcbiAgICAgIGlmIChwYXRoc1tzdGF0ZS5wYXRoXSkge1xuICAgICAgICB2YXIgZnVsbFBhdGhzID0gc3RhdGVzLm1hcChmdW5jdGlvbiAocykge1xuICAgICAgICAgIHJldHVybiBzLmZ1bGxQYXRoKCkgfHwgJ2VtcHR5JztcbiAgICAgICAgfSk7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVHdvIHNpYmxpbmcgc3RhdGVzIGhhdmUgdGhlIHNhbWUgcGF0aCAoJyArIGZ1bGxQYXRocyArICcpJyk7XG4gICAgICB9XG5cbiAgICAgIHBhdGhzW3N0YXRlLnBhdGhdID0gMTtcbiAgICAgIGFzc2VydFBhdGhVbmlxdWVuZXNzKHN0YXRlLmNoaWxkcmVuKTtcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGFzc2VydE5vQW1iaWd1b3VzUGF0aHMoKSB7XG4gICAgdmFyIHBhdGhzID0ge307XG5cbiAgICBmb3IgKHZhciBuYW1lIGluIGxlYWZTdGF0ZXMpIHtcbiAgICAgIHZhciBwYXRoID0gdXRpbC5ub3JtYWxpemVQYXRoUXVlcnkobGVhZlN0YXRlc1tuYW1lXS5mdWxsUGF0aCgpKTtcbiAgICAgIGlmIChwYXRoc1twYXRoXSkgdGhyb3cgbmV3IEVycm9yKCdBbWJpZ3VvdXMgc3RhdGUgcGF0aHM6ICcgKyBwYXRoKTtcbiAgICAgIHBhdGhzW3BhdGhdID0gMTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBhZGREZWZhdWx0U3RhdGVzKHN0YXRlcykge1xuICAgIHN0YXRlcy5mb3JFYWNoKGZ1bmN0aW9uIChzdGF0ZSkge1xuICAgICAgdmFyIGNoaWxkcmVuID0gdXRpbC5vYmplY3RUb0FycmF5KHN0YXRlLnN0YXRlcyk7XG5cbiAgICAgIC8vIFRoaXMgaXMgYSBwYXJlbnQgc3RhdGU6IEFkZCBhIGRlZmF1bHQgc3RhdGUgdG8gaXQgaWYgdGhlcmUgaXNuJ3QgYWxyZWFkeSBvbmVcbiAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGgpIHtcbiAgICAgICAgYWRkRGVmYXVsdFN0YXRlcyhjaGlsZHJlbik7XG5cbiAgICAgICAgdmFyIGhhc0RlZmF1bHRTdGF0ZSA9IGNoaWxkcmVuLnJlZHVjZShmdW5jdGlvbiAocmVzdWx0LCBzdGF0ZSkge1xuICAgICAgICAgIHJldHVybiBzdGF0ZS5wYXRoID09ICcnIHx8IHJlc3VsdDtcbiAgICAgICAgfSwgZmFsc2UpO1xuXG4gICAgICAgIGlmIChoYXNEZWZhdWx0U3RhdGUpIHJldHVybjtcblxuICAgICAgICB2YXIgZGVmYXVsdFN0YXRlID0gU3RhdGUoeyB1cmk6ICcnIH0pO1xuICAgICAgICBzdGF0ZS5zdGF0ZXMuX2RlZmF1bHRfID0gZGVmYXVsdFN0YXRlO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gZWFjaFJvb3RTdGF0ZShjYWxsYmFjaykge1xuICAgIGZvciAodmFyIG5hbWUgaW4gc3RhdGVzKSBjYWxsYmFjayhuYW1lLCBzdGF0ZXNbbmFtZV0pO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVnaXN0ZXJMZWFmU3RhdGVzKHN0YXRlcywgbGVhZlN0YXRlcykge1xuICAgIHJldHVybiBzdGF0ZXMucmVkdWNlKGZ1bmN0aW9uIChsZWFmU3RhdGVzLCBzdGF0ZSkge1xuICAgICAgaWYgKHN0YXRlLmNoaWxkcmVuLmxlbmd0aCkgcmV0dXJuIHJlZ2lzdGVyTGVhZlN0YXRlcyhzdGF0ZS5jaGlsZHJlbiwgbGVhZlN0YXRlcyk7ZWxzZSB7XG4gICAgICAgIGxlYWZTdGF0ZXNbc3RhdGUuZnVsbE5hbWVdID0gc3RhdGU7XG4gICAgICAgIHN0YXRlLnBhdGhzID0gdXRpbC5wYXJzZVBhdGhzKHN0YXRlLmZ1bGxQYXRoKCkpO1xuICAgICAgICByZXR1cm4gbGVhZlN0YXRlcztcbiAgICAgIH1cbiAgICB9LCBsZWFmU3RhdGVzKTtcbiAgfVxuXG4gIC8qXG4gICogUmVxdWVzdCBhIHByb2dyYW1tYXRpYyBzdGF0ZSBjaGFuZ2UuXG4gICpcbiAgKiBUd28gbm90YXRpb25zIGFyZSBzdXBwb3J0ZWQ6XG4gICogdHJhbnNpdGlvblRvKCdteS50YXJnZXQuc3RhdGUnLCB7aWQ6IDMzLCBmaWx0ZXI6ICdkZXNjJ30pXG4gICogdHJhbnNpdGlvblRvKCd0YXJnZXQvMzM/ZmlsdGVyPWRlc2MnKVxuICAqL1xuICBmdW5jdGlvbiB0cmFuc2l0aW9uVG8ocGF0aFF1ZXJ5T3JOYW1lKSB7XG4gICAgdmFyIG5hbWUgPSBsZWFmU3RhdGVzW3BhdGhRdWVyeU9yTmFtZV07XG4gICAgdmFyIHBhcmFtcyA9IChuYW1lID8gYXJndW1lbnRzWzFdIDogbnVsbCkgfHwge307XG4gICAgdmFyIGFjYyA9IG5hbWUgPyBhcmd1bWVudHNbMl0gOiBhcmd1bWVudHNbMV07XG5cbiAgICBsb2dnZXIubG9nKCdDaGFuZ2luZyBzdGF0ZSB0byB7MH0nLCBwYXRoUXVlcnlPck5hbWUgfHwgJ1wiXCInKTtcblxuICAgIHVybENoYW5nZWQgPSBmYWxzZTtcblxuICAgIGlmIChuYW1lKSBzZXRTdGF0ZUJ5TmFtZShuYW1lLCBwYXJhbXMsIGFjYyk7ZWxzZSBzZXRTdGF0ZUZvclBhdGhRdWVyeShwYXRoUXVlcnlPck5hbWUsIGFjYyk7XG4gIH1cblxuICAvKlxuICAqIEF0dGVtcHQgdG8gbmF2aWdhdGUgdG8gJ3N0YXRlTmFtZScgd2l0aCBpdHMgcHJldmlvdXMgcGFyYW1zIG9yXG4gICogZmFsbGJhY2sgdG8gdGhlIGRlZmF1bHRQYXJhbXMgcGFyYW1ldGVyIGlmIHRoZSBzdGF0ZSB3YXMgbmV2ZXIgZW50ZXJlZC5cbiAgKi9cbiAgZnVuY3Rpb24gYmFja1RvKHN0YXRlTmFtZSwgZGVmYXVsdFBhcmFtcywgYWNjKSB7XG4gICAgdmFyIHBhcmFtcyA9IGxlYWZTdGF0ZXNbc3RhdGVOYW1lXS5sYXN0UGFyYW1zIHx8IGRlZmF1bHRQYXJhbXM7XG4gICAgdHJhbnNpdGlvblRvKHN0YXRlTmFtZSwgcGFyYW1zLCBhY2MpO1xuICB9XG5cbiAgZnVuY3Rpb24gc2V0U3RhdGVGb3JQYXRoUXVlcnkocGF0aFF1ZXJ5LCBhY2MpIHtcbiAgICB2YXIgc3RhdGUsIHBhcmFtcywgX3N0YXRlLCBfcGFyYW1zO1xuXG4gICAgY3VycmVudFBhdGhRdWVyeSA9IHV0aWwubm9ybWFsaXplUGF0aFF1ZXJ5KHBhdGhRdWVyeSk7XG5cbiAgICB2YXIgcHEgPSBjdXJyZW50UGF0aFF1ZXJ5LnNwbGl0KCc/Jyk7XG4gICAgdmFyIHBhdGggPSBwcVswXTtcbiAgICB2YXIgcXVlcnkgPSBwcVsxXTtcbiAgICB2YXIgcGF0aHMgPSB1dGlsLnBhcnNlUGF0aHMocGF0aCk7XG4gICAgdmFyIHF1ZXJ5UGFyYW1zID0gdXRpbC5wYXJzZVF1ZXJ5UGFyYW1zKHF1ZXJ5KTtcblxuICAgIGZvciAodmFyIG5hbWUgaW4gbGVhZlN0YXRlcykge1xuICAgICAgX3N0YXRlID0gbGVhZlN0YXRlc1tuYW1lXTtcbiAgICAgIF9wYXJhbXMgPSBfc3RhdGUubWF0Y2hlcyhwYXRocyk7XG5cbiAgICAgIGlmIChfcGFyYW1zKSB7XG4gICAgICAgIHN0YXRlID0gX3N0YXRlO1xuICAgICAgICBwYXJhbXMgPSB1dGlsLm1lcmdlT2JqZWN0cyhfcGFyYW1zLCBxdWVyeVBhcmFtcyk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChzdGF0ZSkgc2V0U3RhdGUoc3RhdGUsIHBhcmFtcywgYWNjKTtlbHNlIG5vdEZvdW5kKGN1cnJlbnRQYXRoUXVlcnkpO1xuICB9XG5cbiAgZnVuY3Rpb24gc2V0U3RhdGVCeU5hbWUobmFtZSwgcGFyYW1zLCBhY2MpIHtcbiAgICB2YXIgc3RhdGUgPSBsZWFmU3RhdGVzW25hbWVdO1xuXG4gICAgaWYgKCFzdGF0ZSkgcmV0dXJuIG5vdEZvdW5kKG5hbWUpO1xuXG4gICAgdmFyIHBhdGhRdWVyeSA9IGludGVycG9sYXRlKHN0YXRlLCBwYXJhbXMpO1xuICAgIHNldFN0YXRlRm9yUGF0aFF1ZXJ5KHBhdGhRdWVyeSwgYWNjKTtcbiAgfVxuXG4gIC8qXG4gICogQWRkIGEgbmV3IHJvb3Qgc3RhdGUgdG8gdGhlIHJvdXRlci5cbiAgKiBUaGUgbmFtZSBtdXN0IGJlIHVuaXF1ZSBhbW9uZyByb290IHN0YXRlcy5cbiAgKi9cbiAgZnVuY3Rpb24gYWRkU3RhdGUobmFtZSwgc3RhdGUpIHtcbiAgICBpZiAoc3RhdGVzW25hbWVdKSB0aHJvdyBuZXcgRXJyb3IoJ0Egc3RhdGUgYWxyZWFkeSBleGlzdCBpbiB0aGUgcm91dGVyIHdpdGggdGhlIG5hbWUgJyArIG5hbWUpO1xuXG4gICAgc3RhdGUgPSBzdGF0ZVRyZWUoc3RhdGUpO1xuXG4gICAgc3RhdGVzW25hbWVdID0gc3RhdGU7XG5cbiAgICBpZiAoaW5pdGlhbGl6ZWQpIHtcbiAgICAgIHN0YXRlLmluaXQocm91dGVyLCBuYW1lKTtcbiAgICAgIHJlZ2lzdGVyTGVhZlN0YXRlcyh7IF86IHN0YXRlIH0pO1xuICAgIH1cblxuICAgIHJldHVybiByb3V0ZXI7XG4gIH1cblxuICAvKlxuICAqIFJlYWQgdGhlIHBhdGgvcXVlcnkgZnJvbSB0aGUgVVJMLlxuICAqL1xuICBmdW5jdGlvbiB1cmxQYXRoUXVlcnkoKSB7XG4gICAgdmFyIGhhc2hTbGFzaCA9IGxvY2F0aW9uLmhyZWYuaW5kZXhPZihoYXNoU2xhc2hTdHJpbmcpO1xuICAgIHZhciBwYXRoUXVlcnk7XG5cbiAgICBpZiAoaGFzaFNsYXNoID4gLTEpIHBhdGhRdWVyeSA9IGxvY2F0aW9uLmhyZWYuc2xpY2UoaGFzaFNsYXNoICsgaGFzaFNsYXNoU3RyaW5nLmxlbmd0aCk7ZWxzZSBpZiAoaXNIYXNoTW9kZSgpKSBwYXRoUXVlcnkgPSAnLyc7ZWxzZSBwYXRoUXVlcnkgPSAobG9jYXRpb24ucGF0aG5hbWUgKyBsb2NhdGlvbi5zZWFyY2gpLnNsaWNlKDEpO1xuXG4gICAgcmV0dXJuIHV0aWwubm9ybWFsaXplUGF0aFF1ZXJ5KHBhdGhRdWVyeSk7XG4gIH1cblxuICBmdW5jdGlvbiBpc0hhc2hNb2RlKCkge1xuICAgIHJldHVybiBvcHRpb25zLnVybFN5bmMgPT0gJ2hhc2gnO1xuICB9XG5cbiAgLypcbiAgKiBDb21wdXRlIGEgbGluayB0aGF0IGNhbiBiZSB1c2VkIGluIGFuY2hvcnMnIGhyZWYgYXR0cmlidXRlc1xuICAqIGZyb20gYSBzdGF0ZSBuYW1lIGFuZCBhIGxpc3Qgb2YgcGFyYW1zLCBhLmsuYSByZXZlcnNlIHJvdXRpbmcuXG4gICovXG4gIGZ1bmN0aW9uIGxpbmsoc3RhdGVOYW1lLCBwYXJhbXMpIHtcbiAgICB2YXIgc3RhdGUgPSBsZWFmU3RhdGVzW3N0YXRlTmFtZV07XG4gICAgaWYgKCFzdGF0ZSkgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgZmluZCBzdGF0ZSAnICsgc3RhdGVOYW1lKTtcblxuICAgIHZhciBpbnRlcnBvbGF0ZWQgPSBpbnRlcnBvbGF0ZShzdGF0ZSwgcGFyYW1zKTtcbiAgICB2YXIgdXJpID0gdXRpbC5ub3JtYWxpemVQYXRoUXVlcnkoaW50ZXJwb2xhdGVkKTtcblxuICAgIHJldHVybiBpc0hhc2hNb2RlKCkgPyAnIycgKyBvcHRpb25zLmhhc2hQcmVmaXggKyB1cmkgOiB1cmk7XG4gIH1cblxuICBmdW5jdGlvbiBpbnRlcnBvbGF0ZShzdGF0ZSwgcGFyYW1zKSB7XG4gICAgdmFyIGVuY29kZWRQYXJhbXMgPSB7fTtcblxuICAgIGZvciAodmFyIGtleSBpbiBwYXJhbXMpIHtcbiAgICAgIGVuY29kZWRQYXJhbXNba2V5XSA9IGVuY29kZVVSSUNvbXBvbmVudChwYXJhbXNba2V5XSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHN0YXRlLmludGVycG9sYXRlKGVuY29kZWRQYXJhbXMpO1xuICB9XG5cbiAgLypcbiAgKiBSZXR1cm5zIGFuIG9iamVjdCByZXByZXNlbnRpbmcgdGhlIGN1cnJlbnQgc3RhdGUgb2YgdGhlIHJvdXRlci5cbiAgKi9cbiAgZnVuY3Rpb24gZ2V0Q3VycmVudCgpIHtcbiAgICByZXR1cm4gY3VycmVudFN0YXRlICYmIGN1cnJlbnRTdGF0ZS5hc1B1YmxpYztcbiAgfVxuXG4gIC8qXG4gICogUmV0dXJucyBhbiBvYmplY3QgcmVwcmVzZW50aW5nIHRoZSBwcmV2aW91cyBzdGF0ZSBvZiB0aGUgcm91dGVyXG4gICogb3IgbnVsbCBpZiB0aGUgcm91dGVyIGlzIHN0aWxsIGluIGl0cyBpbml0aWFsIHN0YXRlLlxuICAqL1xuICBmdW5jdGlvbiBnZXRQcmV2aW91cygpIHtcbiAgICByZXR1cm4gcHJldmlvdXNTdGF0ZSAmJiBwcmV2aW91c1N0YXRlLmFzUHVibGljO1xuICB9XG5cbiAgLypcbiAgKiBSZXR1cm5zIHRoZSBkaWZmIGJldHdlZW4gdGhlIGN1cnJlbnQgcGFyYW1zIGFuZCB0aGUgcHJldmlvdXMgb25lcy5cbiAgKi9cbiAgZnVuY3Rpb24gZ2V0UGFyYW1zRGlmZigpIHtcbiAgICByZXR1cm4gY3VycmVudFBhcmFtc0RpZmY7XG4gIH1cblxuICBmdW5jdGlvbiBhbGxTdGF0ZXNSZWMoc3RhdGVzLCBhY2MpIHtcbiAgICBhY2MucHVzaC5hcHBseShhY2MsIHN0YXRlcyk7XG4gICAgc3RhdGVzLmZvckVhY2goZnVuY3Rpb24gKHN0YXRlKSB7XG4gICAgICByZXR1cm4gYWxsU3RhdGVzUmVjKHN0YXRlLmNoaWxkcmVuLCBhY2MpO1xuICAgIH0pO1xuICAgIHJldHVybiBhY2M7XG4gIH1cblxuICBmdW5jdGlvbiBhbGxTdGF0ZXMoKSB7XG4gICAgcmV0dXJuIGFsbFN0YXRlc1JlYyh1dGlsLm9iamVjdFRvQXJyYXkoc3RhdGVzKSwgW10pO1xuICB9XG5cbiAgLypcbiAgKiBSZXR1cm5zIHRoZSBzdGF0ZSBvYmplY3QgdGhhdCB3YXMgYnVpbHQgd2l0aCB0aGUgZ2l2ZW4gb3B0aW9ucyBvYmplY3Qgb3IgdGhhdCBoYXMgdGhlIGdpdmVuIGZ1bGxOYW1lLlxuICAqIFJldHVybnMgdW5kZWZpbmVkIGlmIHRoZSBzdGF0ZSBkb2Vzbid0IGV4aXN0LlxuICAqL1xuICBmdW5jdGlvbiBmaW5kU3RhdGUoYnkpIHtcbiAgICB2YXIgZmlsdGVyRm4gPSB0eXBlb2YgYnkgPT09ICdvYmplY3QnID8gZnVuY3Rpb24gKHN0YXRlKSB7XG4gICAgICByZXR1cm4gYnkgPT09IHN0YXRlLm9wdGlvbnM7XG4gICAgfSA6IGZ1bmN0aW9uIChzdGF0ZSkge1xuICAgICAgcmV0dXJuIGJ5ID09PSBzdGF0ZS5mdWxsTmFtZTtcbiAgICB9O1xuXG4gICAgdmFyIHN0YXRlID0gYWxsU3RhdGVzKCkuZmlsdGVyKGZpbHRlckZuKVswXTtcbiAgICByZXR1cm4gc3RhdGUgJiYgc3RhdGUuYXNQdWJsaWM7XG4gIH1cblxuICAvKlxuICAqIFJldHVybnMgd2hldGhlciB0aGUgcm91dGVyIGlzIGV4ZWN1dGluZyBpdHMgZmlyc3QgdHJhbnNpdGlvbi5cbiAgKi9cbiAgZnVuY3Rpb24gaXNGaXJzdFRyYW5zaXRpb24oKSB7XG4gICAgcmV0dXJuIHByZXZpb3VzU3RhdGUgPT0gbnVsbDtcbiAgfVxuXG4gIGZ1bmN0aW9uIHN0YXRlVHJlZXMoc3RhdGVzKSB7XG4gICAgcmV0dXJuIHV0aWwubWFwVmFsdWVzKHN0YXRlcywgc3RhdGVUcmVlKTtcbiAgfVxuXG4gIC8qXG4gICogQ3JlYXRlcyBhbiBpbnRlcm5hbCBTdGF0ZSBvYmplY3QgZnJvbSBhIHNwZWNpZmljYXRpb24gUE9KTy5cbiAgKi9cbiAgZnVuY3Rpb24gc3RhdGVUcmVlKHN0YXRlKSB7XG4gICAgaWYgKHN0YXRlLmNoaWxkcmVuKSBzdGF0ZS5jaGlsZHJlbiA9IHN0YXRlVHJlZXMoc3RhdGUuY2hpbGRyZW4pO1xuICAgIHJldHVybiBTdGF0ZShzdGF0ZSk7XG4gIH1cblxuICBmdW5jdGlvbiBsb2dTdGF0ZVRyZWUoKSB7XG4gICAgaWYgKCFsb2dnZXIuZW5hYmxlZCkgcmV0dXJuO1xuXG4gICAgdmFyIGluZGVudCA9IGZ1bmN0aW9uIGluZGVudChsZXZlbCkge1xuICAgICAgaWYgKGxldmVsID09IDApIHJldHVybiAnJztcbiAgICAgIHJldHVybiBuZXcgQXJyYXkoMiArIChsZXZlbCAtIDEpICogNCkuam9pbignICcpICsgJ+KUgOKUgCAnO1xuICAgIH07XG5cbiAgICB2YXIgc3RhdGVUcmVlID0gZnVuY3Rpb24gc3RhdGVUcmVlKHN0YXRlKSB7XG4gICAgICB2YXIgcGF0aCA9IHV0aWwubm9ybWFsaXplUGF0aFF1ZXJ5KHN0YXRlLmZ1bGxQYXRoKCkpO1xuICAgICAgdmFyIHBhdGhTdHIgPSBzdGF0ZS5jaGlsZHJlbi5sZW5ndGggPT0gMCA/ICcgKEAgcGF0aCknLnJlcGxhY2UoJ3BhdGgnLCBwYXRoKSA6ICcnO1xuICAgICAgdmFyIHN0ciA9IGluZGVudChzdGF0ZS5wYXJlbnRzLmxlbmd0aCkgKyBzdGF0ZS5uYW1lICsgcGF0aFN0ciArICdcXG4nO1xuICAgICAgcmV0dXJuIHN0ciArIHN0YXRlLmNoaWxkcmVuLm1hcChzdGF0ZVRyZWUpLmpvaW4oJycpO1xuICAgIH07XG5cbiAgICB2YXIgbXNnID0gJ1xcblN0YXRlIHRyZWVcXG5cXG4nO1xuICAgIG1zZyArPSB1dGlsLm9iamVjdFRvQXJyYXkoc3RhdGVzKS5tYXAoc3RhdGVUcmVlKS5qb2luKCcnKTtcbiAgICBtc2cgKz0gJ1xcbic7XG5cbiAgICBsb2dnZXIubG9nKG1zZyk7XG4gIH1cblxuICAvLyBQdWJsaWMgbWV0aG9kc1xuXG4gIHJvdXRlci5jb25maWd1cmUgPSBjb25maWd1cmU7XG4gIHJvdXRlci5pbml0ID0gaW5pdDtcbiAgcm91dGVyLnRyYW5zaXRpb25UbyA9IHRyYW5zaXRpb25UbztcbiAgcm91dGVyLmJhY2tUbyA9IGJhY2tUbztcbiAgcm91dGVyLmFkZFN0YXRlID0gYWRkU3RhdGU7XG4gIHJvdXRlci5saW5rID0gbGluaztcbiAgcm91dGVyLmN1cnJlbnQgPSBnZXRDdXJyZW50O1xuICByb3V0ZXIucHJldmlvdXMgPSBnZXRQcmV2aW91cztcbiAgcm91dGVyLmZpbmRTdGF0ZSA9IGZpbmRTdGF0ZTtcbiAgcm91dGVyLmlzRmlyc3RUcmFuc2l0aW9uID0gaXNGaXJzdFRyYW5zaXRpb247XG4gIHJvdXRlci5wYXJhbXNEaWZmID0gZ2V0UGFyYW1zRGlmZjtcbiAgcm91dGVyLm9wdGlvbnMgPSBvcHRpb25zO1xuXG4gIHJvdXRlci50cmFuc2l0aW9uID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gIC8vIFVzZWQgZm9yIHRlc3RpbmcgcHVycG9zZXMgb25seVxuICByb3V0ZXIudXJsUGF0aFF1ZXJ5ID0gdXJsUGF0aFF1ZXJ5O1xuICByb3V0ZXIudGVybWluYXRlID0gdGVybWluYXRlO1xuXG4gIHV0aWwubWVyZ2VPYmplY3RzKGFwaSwgcm91dGVyKTtcblxuICByZXR1cm4gcm91dGVyO1xufVxuXG4vLyBMb2dnaW5nXG5cbnZhciBsb2dnZXIgPSB7XG4gIGxvZzogdXRpbC5ub29wLFxuICBlcnJvcjogdXRpbC5ub29wLFxuICBlbmFibGVkOiBmYWxzZVxufTtcblxuUm91dGVyLmVuYWJsZUxvZ3MgPSBmdW5jdGlvbiAoKSB7XG4gIGxvZ2dlci5lbmFibGVkID0gdHJ1ZTtcblxuICBsb2dnZXIubG9nID0gZnVuY3Rpb24gKCkge1xuICAgIGZvciAodmFyIF9sZW4gPSBhcmd1bWVudHMubGVuZ3RoLCBhcmdzID0gQXJyYXkoX2xlbiksIF9rZXkgPSAwOyBfa2V5IDwgX2xlbjsgX2tleSsrKSB7XG4gICAgICBhcmdzW19rZXldID0gYXJndW1lbnRzW19rZXldO1xuICAgIH1cblxuICAgIHZhciBtZXNzYWdlID0gdXRpbC5tYWtlTWVzc2FnZS5hcHBseShudWxsLCBhcmdzKTtcbiAgICBjb25zb2xlLmxvZyhtZXNzYWdlKTtcbiAgfTtcblxuICBsb2dnZXIuZXJyb3IgPSBmdW5jdGlvbiAoKSB7XG4gICAgZm9yICh2YXIgX2xlbjIgPSBhcmd1bWVudHMubGVuZ3RoLCBhcmdzID0gQXJyYXkoX2xlbjIpLCBfa2V5MiA9IDA7IF9rZXkyIDwgX2xlbjI7IF9rZXkyKyspIHtcbiAgICAgIGFyZ3NbX2tleTJdID0gYXJndW1lbnRzW19rZXkyXTtcbiAgICB9XG5cbiAgICB2YXIgbWVzc2FnZSA9IHV0aWwubWFrZU1lc3NhZ2UuYXBwbHkobnVsbCwgYXJncyk7XG4gICAgY29uc29sZS5lcnJvcihtZXNzYWdlKTtcbiAgfTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gUm91dGVyOyIsIlxuJ3VzZSBzdHJpY3QnO1xuXG52YXIgdXRpbCA9IHJlcXVpcmUoJy4vdXRpbCcpO1xuXG52YXIgUEFSQU1TID0gLzpbXlxcXFw/XFwvXSovZztcblxuLypcbiogQ3JlYXRlcyBhIG5ldyBTdGF0ZSBpbnN0YW5jZSBmcm9tIGEge3VyaSwgZW50ZXIsIGV4aXQsIHVwZGF0ZSwgZGF0YSwgY2hpbGRyZW59IG9iamVjdC5cbiogVGhpcyBpcyB0aGUgaW50ZXJuYWwgcmVwcmVzZW50YXRpb24gb2YgYSBzdGF0ZSB1c2VkIGJ5IHRoZSByb3V0ZXIuXG4qL1xuZnVuY3Rpb24gU3RhdGUob3B0aW9ucykge1xuICB2YXIgc3RhdGUgPSB7IG9wdGlvbnM6IG9wdGlvbnMgfSxcbiAgICAgIHN0YXRlcyA9IG9wdGlvbnMuY2hpbGRyZW47XG5cbiAgc3RhdGUucGF0aCA9IHBhdGhGcm9tVVJJKG9wdGlvbnMudXJpKTtcbiAgc3RhdGUucGFyYW1zID0gcGFyYW1zRnJvbVVSSShvcHRpb25zLnVyaSk7XG4gIHN0YXRlLnF1ZXJ5UGFyYW1zID0gcXVlcnlQYXJhbXNGcm9tVVJJKG9wdGlvbnMudXJpKTtcbiAgc3RhdGUuc3RhdGVzID0gc3RhdGVzO1xuXG4gIHN0YXRlLmVudGVyID0gb3B0aW9ucy5lbnRlciB8fCB1dGlsLm5vb3A7XG4gIHN0YXRlLnVwZGF0ZSA9IG9wdGlvbnMudXBkYXRlO1xuICBzdGF0ZS5leGl0ID0gb3B0aW9ucy5leGl0IHx8IHV0aWwubm9vcDtcblxuICBzdGF0ZS5vd25EYXRhID0gb3B0aW9ucy5kYXRhIHx8IHt9O1xuXG4gIC8qXG4gICogSW5pdGlhbGl6ZSBhbmQgZnJlZXplIHRoaXMgc3RhdGUuXG4gICovXG4gIGZ1bmN0aW9uIGluaXQocm91dGVyLCBuYW1lLCBwYXJlbnQpIHtcbiAgICBzdGF0ZS5yb3V0ZXIgPSByb3V0ZXI7XG4gICAgc3RhdGUubmFtZSA9IG5hbWU7XG4gICAgc3RhdGUuaXNEZWZhdWx0ID0gbmFtZSA9PSAnX2RlZmF1bHRfJztcbiAgICBzdGF0ZS5wYXJlbnQgPSBwYXJlbnQ7XG4gICAgc3RhdGUucGFyZW50cyA9IGdldFBhcmVudHMoKTtcbiAgICBzdGF0ZS5yb290ID0gc3RhdGUucGFyZW50ID8gc3RhdGUucGFyZW50c1tzdGF0ZS5wYXJlbnRzLmxlbmd0aCAtIDFdIDogc3RhdGU7XG4gICAgc3RhdGUuY2hpbGRyZW4gPSB1dGlsLm9iamVjdFRvQXJyYXkoc3RhdGVzKTtcbiAgICBzdGF0ZS5mdWxsTmFtZSA9IGdldEZ1bGxOYW1lKCk7XG4gICAgc3RhdGUuYXNQdWJsaWMgPSBtYWtlUHVibGljQVBJKCk7XG5cbiAgICBlYWNoQ2hpbGRTdGF0ZShmdW5jdGlvbiAobmFtZSwgY2hpbGRTdGF0ZSkge1xuICAgICAgY2hpbGRTdGF0ZS5pbml0KHJvdXRlciwgbmFtZSwgc3RhdGUpO1xuICAgIH0pO1xuICB9XG5cbiAgLypcbiAgKiBUaGUgZnVsbCBwYXRoLCBjb21wb3NlZCBvZiBhbGwgdGhlIGluZGl2aWR1YWwgcGF0aHMgb2YgdGhpcyBzdGF0ZSBhbmQgaXRzIHBhcmVudHMuXG4gICovXG4gIGZ1bmN0aW9uIGZ1bGxQYXRoKCkge1xuICAgIHZhciByZXN1bHQgPSBzdGF0ZS5wYXRoLFxuICAgICAgICBzdGF0ZVBhcmVudCA9IHN0YXRlLnBhcmVudDtcblxuICAgIHdoaWxlIChzdGF0ZVBhcmVudCkge1xuICAgICAgaWYgKHN0YXRlUGFyZW50LnBhdGgpIHJlc3VsdCA9IHN0YXRlUGFyZW50LnBhdGggKyAnLycgKyByZXN1bHQ7XG4gICAgICBzdGF0ZVBhcmVudCA9IHN0YXRlUGFyZW50LnBhcmVudDtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLypcbiAgKiBUaGUgbGlzdCBvZiBhbGwgcGFyZW50cywgc3RhcnRpbmcgZnJvbSB0aGUgY2xvc2VzdCBvbmVzLlxuICAqL1xuICBmdW5jdGlvbiBnZXRQYXJlbnRzKCkge1xuICAgIHZhciBwYXJlbnRzID0gW10sXG4gICAgICAgIHBhcmVudCA9IHN0YXRlLnBhcmVudDtcblxuICAgIHdoaWxlIChwYXJlbnQpIHtcbiAgICAgIHBhcmVudHMucHVzaChwYXJlbnQpO1xuICAgICAgcGFyZW50ID0gcGFyZW50LnBhcmVudDtcbiAgICB9XG5cbiAgICByZXR1cm4gcGFyZW50cztcbiAgfVxuXG4gIC8qXG4gICogVGhlIGZ1bGx5IHF1YWxpZmllZCBuYW1lIG9mIHRoaXMgc3RhdGUuXG4gICogZS5nIGdyYW5wYXJlbnROYW1lLnBhcmVudE5hbWUubmFtZVxuICAqL1xuICBmdW5jdGlvbiBnZXRGdWxsTmFtZSgpIHtcbiAgICB2YXIgcmVzdWx0ID0gc3RhdGUucGFyZW50cy5yZWR1Y2VSaWdodChmdW5jdGlvbiAoYWNjLCBwYXJlbnQpIHtcbiAgICAgIHJldHVybiBhY2MgKyBwYXJlbnQubmFtZSArICcuJztcbiAgICB9LCAnJykgKyBzdGF0ZS5uYW1lO1xuXG4gICAgcmV0dXJuIHN0YXRlLmlzRGVmYXVsdCA/IHJlc3VsdC5yZXBsYWNlKCcuX2RlZmF1bHRfJywgJycpIDogcmVzdWx0O1xuICB9XG5cbiAgZnVuY3Rpb24gYWxsUXVlcnlQYXJhbXMoKSB7XG4gICAgcmV0dXJuIHN0YXRlLnBhcmVudHMucmVkdWNlKGZ1bmN0aW9uIChhY2MsIHBhcmVudCkge1xuICAgICAgcmV0dXJuIHV0aWwubWVyZ2VPYmplY3RzKGFjYywgcGFyZW50LnF1ZXJ5UGFyYW1zKTtcbiAgICB9LCB1dGlsLmNvcHlPYmplY3Qoc3RhdGUucXVlcnlQYXJhbXMpKTtcbiAgfVxuXG4gIC8qXG4gICogR2V0IG9yIFNldCBzb21lIGFyYml0cmFyeSBkYXRhIGJ5IGtleSBvbiB0aGlzIHN0YXRlLlxuICAqIGNoaWxkIHN0YXRlcyBoYXZlIGFjY2VzcyB0byB0aGVpciBwYXJlbnRzJyBkYXRhLlxuICAqXG4gICogVGhpcyBjYW4gYmUgdXNlZnVsIHdoZW4gdXNpbmcgZXh0ZXJuYWwgbW9kZWxzL3NlcnZpY2VzXG4gICogYXMgYSBtZWFuIHRvIGNvbW11bmljYXRlIGJldHdlZW4gc3RhdGVzIGlzIG5vdCBkZXNpcmVkLlxuICAqL1xuICBmdW5jdGlvbiBkYXRhKGtleSwgdmFsdWUpIHtcbiAgICBpZiAodmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgc3RhdGUub3duRGF0YVtrZXldID0gdmFsdWU7XG4gICAgICByZXR1cm4gc3RhdGU7XG4gICAgfVxuXG4gICAgdmFyIGN1cnJlbnRTdGF0ZSA9IHN0YXRlO1xuXG4gICAgd2hpbGUgKGN1cnJlbnRTdGF0ZS5vd25EYXRhW2tleV0gPT09IHVuZGVmaW5lZCAmJiBjdXJyZW50U3RhdGUucGFyZW50KSBjdXJyZW50U3RhdGUgPSBjdXJyZW50U3RhdGUucGFyZW50O1xuXG4gICAgcmV0dXJuIGN1cnJlbnRTdGF0ZS5vd25EYXRhW2tleV07XG4gIH1cblxuICBmdW5jdGlvbiBtYWtlUHVibGljQVBJKCkge1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiBzdGF0ZS5uYW1lLFxuICAgICAgZnVsbE5hbWU6IHN0YXRlLmZ1bGxOYW1lLFxuICAgICAgcGFyZW50OiBzdGF0ZS5wYXJlbnQgJiYgc3RhdGUucGFyZW50LmFzUHVibGljLFxuICAgICAgZGF0YTogZGF0YVxuICAgIH07XG4gIH1cblxuICBmdW5jdGlvbiBlYWNoQ2hpbGRTdGF0ZShjYWxsYmFjaykge1xuICAgIGZvciAodmFyIG5hbWUgaW4gc3RhdGVzKSBjYWxsYmFjayhuYW1lLCBzdGF0ZXNbbmFtZV0pO1xuICB9XG5cbiAgLypcbiAgKiBSZXR1cm5zIHdoZXRoZXIgdGhpcyBzdGF0ZSBtYXRjaGVzIHRoZSBwYXNzZWQgcGF0aCBBcnJheS5cbiAgKiBJbiBjYXNlIG9mIGEgbWF0Y2gsIHRoZSBhY3R1YWwgcGFyYW0gdmFsdWVzIGFyZSByZXR1cm5lZC5cbiAgKi9cbiAgZnVuY3Rpb24gbWF0Y2hlcyhwYXRocykge1xuICAgIHZhciBwYXJhbXMgPSB7fTtcbiAgICB2YXIgbm9uUmVzdFN0YXRlUGF0aHMgPSBzdGF0ZS5wYXRocy5maWx0ZXIoZnVuY3Rpb24gKHApIHtcbiAgICAgIHJldHVybiBwW3AubGVuZ3RoIC0gMV0gIT0gJyonO1xuICAgIH0pO1xuXG4gICAgLyogVGhpcyBzdGF0ZSBoYXMgbW9yZSBwYXRocyB0aGFuIHRoZSBwYXNzZWQgcGF0aHMsIGl0IGNhbm5vdCBiZSBhIG1hdGNoICovXG4gICAgaWYgKG5vblJlc3RTdGF0ZVBhdGhzLmxlbmd0aCA+IHBhdGhzLmxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgLyogQ2hlY2tzIGlmIHRoZSBwYXRocyBtYXRjaCBvbmUgYnkgb25lICovXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwYXRocy5sZW5ndGg7IGkrKykge1xuICAgICAgdmFyIHBhdGggPSBwYXRoc1tpXTtcbiAgICAgIHZhciB0aGF0UGF0aCA9IHN0YXRlLnBhdGhzW2ldO1xuXG4gICAgICAvKiBUaGlzIHN0YXRlIGhhcyBsZXNzIHBhdGhzIHRoYW4gdGhlIHBhc3NlZCBwYXRocywgaXQgY2Fubm90IGJlIGEgbWF0Y2ggKi9cbiAgICAgIGlmICghdGhhdFBhdGgpIHJldHVybiBmYWxzZTtcblxuICAgICAgdmFyIGlzUmVzdCA9IHRoYXRQYXRoW3RoYXRQYXRoLmxlbmd0aCAtIDFdID09ICcqJztcbiAgICAgIGlmIChpc1Jlc3QpIHtcbiAgICAgICAgdmFyIG5hbWUgPSBwYXJhbU5hbWUodGhhdFBhdGgpO1xuICAgICAgICBwYXJhbXNbbmFtZV0gPSBwYXRocy5zbGljZShpKS5qb2luKCcvJyk7XG4gICAgICAgIHJldHVybiBwYXJhbXM7XG4gICAgICB9XG5cbiAgICAgIHZhciBpc0R5bmFtaWMgPSB0aGF0UGF0aFswXSA9PSAnOic7XG4gICAgICBpZiAoaXNEeW5hbWljKSB7XG4gICAgICAgIHZhciBuYW1lID0gcGFyYW1OYW1lKHRoYXRQYXRoKTtcbiAgICAgICAgcGFyYW1zW25hbWVdID0gcGF0aDtcbiAgICAgIH0gZWxzZSBpZiAodGhhdFBhdGggIT0gcGF0aCkgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHJldHVybiBwYXJhbXM7XG4gIH1cblxuICAvKlxuICAqIFJldHVybnMgYSBVUkkgYnVpbHQgZnJvbSB0aGlzIHN0YXRlIGFuZCB0aGUgcGFzc2VkIHBhcmFtcy5cbiAgKi9cbiAgZnVuY3Rpb24gaW50ZXJwb2xhdGUocGFyYW1zKSB7XG4gICAgdmFyIHBhdGggPSBzdGF0ZS5mdWxsUGF0aCgpLnJlcGxhY2UoUEFSQU1TLCBmdW5jdGlvbiAocCkge1xuICAgICAgcmV0dXJuIHBhcmFtc1twYXJhbU5hbWUocCldIHx8ICcnO1xuICAgIH0pO1xuXG4gICAgdmFyIHF1ZXJ5UGFyYW1zID0gYWxsUXVlcnlQYXJhbXMoKTtcbiAgICB2YXIgcGFzc2VkUXVlcnlQYXJhbXMgPSBPYmplY3Qua2V5cyhwYXJhbXMpLmZpbHRlcihmdW5jdGlvbiAocCkge1xuICAgICAgcmV0dXJuIHF1ZXJ5UGFyYW1zW3BdO1xuICAgIH0pO1xuXG4gICAgdmFyIHF1ZXJ5ID0gcGFzc2VkUXVlcnlQYXJhbXMubWFwKGZ1bmN0aW9uIChwKSB7XG4gICAgICByZXR1cm4gcCArICc9JyArIHBhcmFtc1twXTtcbiAgICB9KS5qb2luKCcmJyk7XG5cbiAgICByZXR1cm4gcGF0aCArIChxdWVyeS5sZW5ndGggPyAnPycgKyBxdWVyeSA6ICcnKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHRvU3RyaW5nKCkge1xuICAgIHJldHVybiBzdGF0ZS5mdWxsTmFtZTtcbiAgfVxuXG4gIHN0YXRlLmluaXQgPSBpbml0O1xuICBzdGF0ZS5mdWxsUGF0aCA9IGZ1bGxQYXRoO1xuICBzdGF0ZS5hbGxRdWVyeVBhcmFtcyA9IGFsbFF1ZXJ5UGFyYW1zO1xuICBzdGF0ZS5tYXRjaGVzID0gbWF0Y2hlcztcbiAgc3RhdGUuaW50ZXJwb2xhdGUgPSBpbnRlcnBvbGF0ZTtcbiAgc3RhdGUuZGF0YSA9IGRhdGE7XG4gIHN0YXRlLnRvU3RyaW5nID0gdG9TdHJpbmc7XG5cbiAgcmV0dXJuIHN0YXRlO1xufVxuXG5mdW5jdGlvbiBwYXJhbU5hbWUocGFyYW0pIHtcbiAgcmV0dXJuIHBhcmFtW3BhcmFtLmxlbmd0aCAtIDFdID09ICcqJyA/IHBhcmFtLnN1YnN0cigxKS5zbGljZSgwLCAtMSkgOiBwYXJhbS5zdWJzdHIoMSk7XG59XG5cbmZ1bmN0aW9uIHBhdGhGcm9tVVJJKHVyaSkge1xuICByZXR1cm4gKHVyaSB8fCAnJykuc3BsaXQoJz8nKVswXTtcbn1cblxuZnVuY3Rpb24gcGFyYW1zRnJvbVVSSSh1cmkpIHtcbiAgdmFyIG1hdGNoZXMgPSBQQVJBTVMuZXhlYyh1cmkpO1xuICByZXR1cm4gbWF0Y2hlcyA/IHV0aWwuYXJyYXlUb09iamVjdChtYXRjaGVzLm1hcChwYXJhbU5hbWUpKSA6IHt9O1xufVxuXG5mdW5jdGlvbiBxdWVyeVBhcmFtc0Zyb21VUkkodXJpKSB7XG4gIHZhciBxdWVyeSA9ICh1cmkgfHwgJycpLnNwbGl0KCc/JylbMV07XG4gIHJldHVybiBxdWVyeSA/IHV0aWwuYXJyYXlUb09iamVjdChxdWVyeS5zcGxpdCgnJicpKSA6IHt9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IFN0YXRlOyIsIlxuJ3VzZSBzdHJpY3QnO1xuXG4vKlxuKiBDcmVhdGVzIGEgbmV3IFN0YXRlV2l0aFBhcmFtcyBpbnN0YW5jZS5cbipcbiogU3RhdGVXaXRoUGFyYW1zIGlzIHRoZSBtZXJnZSBiZXR3ZWVuIGEgU3RhdGUgb2JqZWN0IChjcmVhdGVkIGFuZCBhZGRlZCB0byB0aGUgcm91dGVyIGJlZm9yZSBpbml0KVxuKiBhbmQgcGFyYW1zIChib3RoIHBhdGggYW5kIHF1ZXJ5IHBhcmFtcywgZXh0cmFjdGVkIGZyb20gdGhlIFVSTCBhZnRlciBpbml0KVxuKlxuKiBUaGlzIGlzIGFuIGludGVybmFsIG1vZGVsOyBUaGUgcHVibGljIG1vZGVsIGlzIHRoZSBhc1B1YmxpYyBwcm9wZXJ0eS5cbiovXG5mdW5jdGlvbiBTdGF0ZVdpdGhQYXJhbXMoc3RhdGUsIHBhcmFtcywgcGF0aFF1ZXJ5KSB7XG4gIHJldHVybiB7XG4gICAgc3RhdGU6IHN0YXRlLFxuICAgIHBhcmFtczogcGFyYW1zLFxuICAgIHRvU3RyaW5nOiB0b1N0cmluZyxcbiAgICBhc1B1YmxpYzogbWFrZVB1YmxpY0FQSShzdGF0ZSwgcGFyYW1zLCBwYXRoUXVlcnkpXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VQdWJsaWNBUEkoc3RhdGUsIHBhcmFtcywgcGF0aFF1ZXJ5KSB7XG5cbiAgLypcbiAgKiBSZXR1cm5zIHdoZXRoZXIgdGhpcyBzdGF0ZSBvciBhbnkgb2YgaXRzIHBhcmVudHMgaGFzIHRoZSBnaXZlbiBmdWxsTmFtZS5cbiAgKi9cbiAgZnVuY3Rpb24gaXNJbihmdWxsU3RhdGVOYW1lKSB7XG4gICAgdmFyIGN1cnJlbnQgPSBzdGF0ZTtcbiAgICB3aGlsZSAoY3VycmVudCkge1xuICAgICAgaWYgKGN1cnJlbnQuZnVsbE5hbWUgPT0gZnVsbFN0YXRlTmFtZSkgcmV0dXJuIHRydWU7XG4gICAgICBjdXJyZW50ID0gY3VycmVudC5wYXJlbnQ7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgdXJpOiBwYXRoUXVlcnksXG4gICAgcGFyYW1zOiBwYXJhbXMsXG4gICAgbmFtZTogc3RhdGUgPyBzdGF0ZS5uYW1lIDogJycsXG4gICAgZnVsbE5hbWU6IHN0YXRlID8gc3RhdGUuZnVsbE5hbWUgOiAnJyxcbiAgICBkYXRhOiBzdGF0ZSA/IHN0YXRlLmRhdGEgOiBudWxsLFxuICAgIGlzSW46IGlzSW5cbiAgfTtcbn1cblxuZnVuY3Rpb24gdG9TdHJpbmcoKSB7XG4gIHZhciBuYW1lID0gdGhpcy5zdGF0ZSAmJiB0aGlzLnN0YXRlLmZ1bGxOYW1lO1xuICByZXR1cm4gbmFtZSArICc6JyArIEpTT04uc3RyaW5naWZ5KHRoaXMucGFyYW1zKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBTdGF0ZVdpdGhQYXJhbXM7IiwiXG4ndXNlIHN0cmljdCc7XG5cbi8qXG4qIENyZWF0ZSBhIG5ldyBUcmFuc2l0aW9uIGluc3RhbmNlLlxuKi9cbmZ1bmN0aW9uIFRyYW5zaXRpb24oZnJvbVN0YXRlV2l0aFBhcmFtcywgdG9TdGF0ZVdpdGhQYXJhbXMsIHBhcmFtc0RpZmYsIGFjYywgcm91dGVyLCBsb2dnZXIpIHtcbiAgdmFyIHJvb3QsIGVudGVycywgZXhpdHM7XG5cbiAgdmFyIGZyb21TdGF0ZSA9IGZyb21TdGF0ZVdpdGhQYXJhbXMgJiYgZnJvbVN0YXRlV2l0aFBhcmFtcy5zdGF0ZTtcbiAgdmFyIHRvU3RhdGUgPSB0b1N0YXRlV2l0aFBhcmFtcy5zdGF0ZTtcbiAgdmFyIHBhcmFtcyA9IHRvU3RhdGVXaXRoUGFyYW1zLnBhcmFtcztcbiAgdmFyIGlzVXBkYXRlID0gZnJvbVN0YXRlID09IHRvU3RhdGU7XG5cbiAgdmFyIHRyYW5zaXRpb24gPSB7XG4gICAgZnJvbTogZnJvbVN0YXRlLFxuICAgIHRvOiB0b1N0YXRlLFxuICAgIHRvUGFyYW1zOiBwYXJhbXMsXG4gICAgY2FuY2VsOiBjYW5jZWwsXG4gICAgY2FuY2VsbGVkOiBmYWxzZSxcbiAgICBjdXJyZW50U3RhdGU6IGZyb21TdGF0ZSxcbiAgICBydW46IHJ1blxuICB9O1xuXG4gIC8vIFRoZSBmaXJzdCB0cmFuc2l0aW9uIGhhcyBubyBmcm9tU3RhdGUuXG4gIGlmIChmcm9tU3RhdGUpIHJvb3QgPSB0cmFuc2l0aW9uUm9vdChmcm9tU3RhdGUsIHRvU3RhdGUsIGlzVXBkYXRlLCBwYXJhbXNEaWZmKTtcblxuICB2YXIgaW5jbHVzaXZlID0gIXJvb3QgfHwgaXNVcGRhdGU7XG4gIGV4aXRzID0gZnJvbVN0YXRlID8gdHJhbnNpdGlvblN0YXRlcyhmcm9tU3RhdGUsIHJvb3QsIGluY2x1c2l2ZSkgOiBbXTtcbiAgZW50ZXJzID0gdHJhbnNpdGlvblN0YXRlcyh0b1N0YXRlLCByb290LCBpbmNsdXNpdmUpLnJldmVyc2UoKTtcblxuICBmdW5jdGlvbiBydW4oKSB7XG4gICAgc3RhcnRUcmFuc2l0aW9uKGVudGVycywgZXhpdHMsIHBhcmFtcywgdHJhbnNpdGlvbiwgaXNVcGRhdGUsIGFjYywgcm91dGVyLCBsb2dnZXIpO1xuICB9XG5cbiAgZnVuY3Rpb24gY2FuY2VsKCkge1xuICAgIHRyYW5zaXRpb24uY2FuY2VsbGVkID0gdHJ1ZTtcbiAgfVxuXG4gIHJldHVybiB0cmFuc2l0aW9uO1xufVxuXG5mdW5jdGlvbiBzdGFydFRyYW5zaXRpb24oZW50ZXJzLCBleGl0cywgcGFyYW1zLCB0cmFuc2l0aW9uLCBpc1VwZGF0ZSwgYWNjLCByb3V0ZXIsIGxvZ2dlcikge1xuICBhY2MgPSBhY2MgfHwge307XG5cbiAgdHJhbnNpdGlvbi5leGl0aW5nID0gdHJ1ZTtcbiAgZXhpdHMuZm9yRWFjaChmdW5jdGlvbiAoc3RhdGUpIHtcbiAgICBpZiAoaXNVcGRhdGUgJiYgc3RhdGUudXBkYXRlKSByZXR1cm47XG4gICAgcnVuU3RlcChzdGF0ZSwgJ2V4aXQnLCBwYXJhbXMsIHRyYW5zaXRpb24sIGFjYywgcm91dGVyLCBsb2dnZXIpO1xuICB9KTtcbiAgdHJhbnNpdGlvbi5leGl0aW5nID0gZmFsc2U7XG5cbiAgZW50ZXJzLmZvckVhY2goZnVuY3Rpb24gKHN0YXRlKSB7XG4gICAgdmFyIGZuID0gaXNVcGRhdGUgJiYgc3RhdGUudXBkYXRlID8gJ3VwZGF0ZScgOiAnZW50ZXInO1xuICAgIHJ1blN0ZXAoc3RhdGUsIGZuLCBwYXJhbXMsIHRyYW5zaXRpb24sIGFjYywgcm91dGVyLCBsb2dnZXIpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcnVuU3RlcChzdGF0ZSwgc3RlcEZuLCBwYXJhbXMsIHRyYW5zaXRpb24sIGFjYywgcm91dGVyLCBsb2dnZXIpIHtcbiAgaWYgKHRyYW5zaXRpb24uY2FuY2VsbGVkKSByZXR1cm47XG5cbiAgaWYgKGxvZ2dlci5lbmFibGVkKSB7XG4gICAgdmFyIGNhcGl0YWxpemVkU3RlcCA9IHN0ZXBGblswXS50b1VwcGVyQ2FzZSgpICsgc3RlcEZuLnNsaWNlKDEpO1xuICAgIGxvZ2dlci5sb2coY2FwaXRhbGl6ZWRTdGVwICsgJyAnICsgc3RhdGUuZnVsbE5hbWUpO1xuICB9XG5cbiAgdmFyIHJlc3VsdCA9IHN0YXRlW3N0ZXBGbl0ocGFyYW1zLCBhY2MsIHJvdXRlcik7XG5cbiAgaWYgKHRyYW5zaXRpb24uY2FuY2VsbGVkKSByZXR1cm47XG5cbiAgdHJhbnNpdGlvbi5jdXJyZW50U3RhdGUgPSBzdGVwRm4gPT0gJ2V4aXQnID8gc3RhdGUucGFyZW50IDogc3RhdGU7XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuLypcbiogVGhlIHRvcC1tb3N0IGN1cnJlbnQgc3RhdGUncyBwYXJlbnQgdGhhdCBtdXN0IGJlIGV4aXRlZC5cbiovXG5mdW5jdGlvbiB0cmFuc2l0aW9uUm9vdChmcm9tU3RhdGUsIHRvU3RhdGUsIGlzVXBkYXRlLCBwYXJhbXNEaWZmKSB7XG4gIHZhciByb290LCBwYXJlbnQsIHBhcmFtO1xuXG4gIC8vIEZvciBhIHBhcmFtLW9ubHkgY2hhbmdlLCB0aGUgcm9vdCBpcyB0aGUgdG9wLW1vc3Qgc3RhdGUgb3duaW5nIHRoZSBwYXJhbShzKSxcbiAgaWYgKGlzVXBkYXRlKSB7XG4gICAgW2Zyb21TdGF0ZV0uY29uY2F0KGZyb21TdGF0ZS5wYXJlbnRzKS5yZXZlcnNlKCkuZm9yRWFjaChmdW5jdGlvbiAocGFyZW50KSB7XG4gICAgICBpZiAocm9vdCkgcmV0dXJuO1xuXG4gICAgICBmb3IgKHBhcmFtIGluIHBhcmFtc0RpZmYuYWxsKSB7XG4gICAgICAgIGlmIChwYXJlbnQucGFyYW1zW3BhcmFtXSB8fCBwYXJlbnQucXVlcnlQYXJhbXNbcGFyYW1dKSB7XG4gICAgICAgICAgcm9vdCA9IHBhcmVudDtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIC8vIEVsc2UsIHRoZSByb290IGlzIHRoZSBjbG9zZXN0IGNvbW1vbiBwYXJlbnQgb2YgdGhlIHR3byBzdGF0ZXMuXG4gIGVsc2Uge1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmcm9tU3RhdGUucGFyZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBwYXJlbnQgPSBmcm9tU3RhdGUucGFyZW50c1tpXTtcbiAgICAgICAgaWYgKHRvU3RhdGUucGFyZW50cy5pbmRleE9mKHBhcmVudCkgPiAtMSkge1xuICAgICAgICAgIHJvb3QgPSBwYXJlbnQ7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgcmV0dXJuIHJvb3Q7XG59XG5cbmZ1bmN0aW9uIHRyYW5zaXRpb25TdGF0ZXMoc3RhdGUsIHJvb3QsIGluY2x1c2l2ZSkge1xuICByb290ID0gcm9vdCB8fCBzdGF0ZS5yb290O1xuXG4gIHZhciBwID0gc3RhdGUucGFyZW50cyxcbiAgICAgIGVuZCA9IE1hdGgubWluKHAubGVuZ3RoLCBwLmluZGV4T2Yocm9vdCkgKyAoaW5jbHVzaXZlID8gMSA6IDApKTtcblxuICByZXR1cm4gW3N0YXRlXS5jb25jYXQocC5zbGljZSgwLCBlbmQpKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBUcmFuc2l0aW9uOyIsIlxuJ3VzZSBzdHJpY3QnO1xuXG52YXIgcm91dGVyO1xuXG5mdW5jdGlvbiBvbk1vdXNlRG93bihldnQpIHtcbiAgdmFyIGhyZWYgPSBocmVmRm9yRXZlbnQoZXZ0KTtcblxuICBpZiAoaHJlZiAhPT0gdW5kZWZpbmVkKSByb3V0ZXIudHJhbnNpdGlvblRvKGhyZWYpO1xufVxuXG5mdW5jdGlvbiBvbk1vdXNlQ2xpY2soZXZ0KSB7XG4gIHZhciBocmVmID0gaHJlZkZvckV2ZW50KGV2dCk7XG5cbiAgaWYgKGhyZWYgIT09IHVuZGVmaW5lZCkge1xuICAgIGV2dC5wcmV2ZW50RGVmYXVsdCgpO1xuXG4gICAgcm91dGVyLnRyYW5zaXRpb25UbyhocmVmKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBocmVmRm9yRXZlbnQoZXZ0KSB7XG4gIGlmIChldnQuZGVmYXVsdFByZXZlbnRlZCB8fCBldnQubWV0YUtleSB8fCBldnQuY3RybEtleSB8fCAhaXNMZWZ0QnV0dG9uKGV2dCkpIHJldHVybjtcblxuICB2YXIgdGFyZ2V0ID0gZXZ0LnRhcmdldDtcbiAgdmFyIGFuY2hvciA9IGFuY2hvclRhcmdldCh0YXJnZXQpO1xuICBpZiAoIWFuY2hvcikgcmV0dXJuO1xuXG4gIHZhciBkYXRhTmF2ID0gYW5jaG9yLmdldEF0dHJpYnV0ZSgnZGF0YS1uYXYnKTtcblxuICBpZiAoZGF0YU5hdiA9PSAnaWdub3JlJykgcmV0dXJuO1xuICBpZiAoZXZ0LnR5cGUgPT0gJ21vdXNlZG93bicgJiYgZGF0YU5hdiAhPSAnbW91c2Vkb3duJykgcmV0dXJuO1xuXG4gIHZhciBocmVmID0gYW5jaG9yLmdldEF0dHJpYnV0ZSgnaHJlZicpO1xuXG4gIGlmICghaHJlZikgcmV0dXJuO1xuICBpZiAoaHJlZi5jaGFyQXQoMCkgPT0gJyMnKSB7XG4gICAgaWYgKHJvdXRlci5vcHRpb25zLnVybFN5bmMgIT0gJ2hhc2gnKSByZXR1cm47XG4gICAgaHJlZiA9IGhyZWYuc2xpY2UoMSk7XG4gIH1cbiAgaWYgKGFuY2hvci5nZXRBdHRyaWJ1dGUoJ3RhcmdldCcpID09ICdfYmxhbmsnKSByZXR1cm47XG4gIGlmICghaXNMb2NhbExpbmsoYW5jaG9yKSkgcmV0dXJuO1xuXG4gIC8vIEF0IHRoaXMgcG9pbnQsIHdlIGhhdmUgYSB2YWxpZCBocmVmIHRvIGZvbGxvdy5cbiAgLy8gRGlkIHRoZSBuYXZpZ2F0aW9uIGFscmVhZHkgb2NjdXIgb24gbW91c2Vkb3duIHRob3VnaD9cbiAgaWYgKGV2dC50eXBlID09ICdjbGljaycgJiYgZGF0YU5hdiA9PSAnbW91c2Vkb3duJykge1xuICAgIGV2dC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHJldHVybiBocmVmO1xufVxuXG5mdW5jdGlvbiBpc0xlZnRCdXR0b24oZXZ0KSB7XG4gIHJldHVybiBldnQud2hpY2ggPT0gMTtcbn1cblxuZnVuY3Rpb24gYW5jaG9yVGFyZ2V0KHRhcmdldCkge1xuICB3aGlsZSAodGFyZ2V0KSB7XG4gICAgaWYgKHRhcmdldC5ub2RlTmFtZSA9PSAnQScpIHJldHVybiB0YXJnZXQ7XG4gICAgdGFyZ2V0ID0gdGFyZ2V0LnBhcmVudE5vZGU7XG4gIH1cbn1cblxuZnVuY3Rpb24gaXNMb2NhbExpbmsoYW5jaG9yKSB7XG4gIHZhciBob3N0bmFtZSA9IGFuY2hvci5ob3N0bmFtZTtcbiAgdmFyIHBvcnQgPSBhbmNob3IucG9ydDtcblxuICAvLyBJRTEwIGNhbiBsb3NlIHRoZSBob3N0bmFtZS9wb3J0IHByb3BlcnR5IHdoZW4gc2V0dGluZyBhIHJlbGF0aXZlIGhyZWYgZnJvbSBKU1xuICBpZiAoIWhvc3RuYW1lKSB7XG4gICAgdmFyIHRlbXBBbmNob3IgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICB0ZW1wQW5jaG9yLmhyZWYgPSBhbmNob3IuaHJlZjtcbiAgICBob3N0bmFtZSA9IHRlbXBBbmNob3IuaG9zdG5hbWU7XG4gICAgcG9ydCA9IHRlbXBBbmNob3IucG9ydDtcbiAgfVxuXG4gIHZhciBzYW1lSG9zdG5hbWUgPSBob3N0bmFtZSA9PSBsb2NhdGlvbi5ob3N0bmFtZTtcbiAgdmFyIHNhbWVQb3J0ID0gKHBvcnQgfHwgJzgwJykgPT0gKGxvY2F0aW9uLnBvcnQgfHwgJzgwJyk7XG5cbiAgcmV0dXJuIHNhbWVIb3N0bmFtZSAmJiBzYW1lUG9ydDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpbnRlcmNlcHRBbmNob3JzKGZvclJvdXRlcikge1xuICByb3V0ZXIgPSBmb3JSb3V0ZXI7XG5cbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vkb3duJywgb25Nb3VzZURvd24pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIG9uTW91c2VDbGljayk7XG59OyIsIlxuLyogUmVwcmVzZW50cyB0aGUgcHVibGljIEFQSSBvZiB0aGUgbGFzdCBpbnN0YW5jaWF0ZWQgcm91dGVyOyBVc2VmdWwgdG8gYnJlYWsgY2lyY3VsYXIgZGVwZW5kZW5jaWVzIGJldHdlZW4gcm91dGVyIGFuZCBpdHMgc3RhdGVzICovXG5cInVzZSBzdHJpY3RcIjtcblxubW9kdWxlLmV4cG9ydHMgPSB7fTsiLCIndXNlIHN0cmljdCc7XG5cbnZhciBhcGkgPSByZXF1aXJlKCcuL2FwaScpO1xuXG4vKiBXcmFwcyBhIHRoZW5uYWJsZS9wcm9taXNlIGFuZCBvbmx5IHJlc29sdmUgaXQgaWYgdGhlIHJvdXRlciBkaWRuJ3QgdHJhbnNpdGlvbiB0byBhbm90aGVyIHN0YXRlIGluIHRoZSBtZWFudGltZSAqL1xuZnVuY3Rpb24gYXN5bmMod3JhcHBlZCkge1xuICB2YXIgUHJvbWlzZUltcGwgPSBhc3luYy5Qcm9taXNlIHx8IFByb21pc2U7XG4gIHZhciBmaXJlID0gdHJ1ZTtcblxuICBhcGkudHJhbnNpdGlvbi5vbmNlKCdzdGFydGVkJywgZnVuY3Rpb24gKCkge1xuICAgIGZpcmUgPSBmYWxzZTtcbiAgfSk7XG5cbiAgdmFyIHByb21pc2UgPSBuZXcgUHJvbWlzZUltcGwoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHdyYXBwZWQudGhlbihmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgIGlmIChmaXJlKSByZXNvbHZlKHZhbHVlKTtcbiAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBpZiAoZmlyZSkgcmVqZWN0KGVycik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJldHVybiBwcm9taXNlO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBhc3luYzsiLCJcbid1c2Ugc3RyaWN0JztcblxudmFyIHV0aWwgPSByZXF1aXJlKCcuL3V0aWwnKTtcblxudmFyIEFieXNzYSA9IHtcbiAgUm91dGVyOiByZXF1aXJlKCcuL1JvdXRlcicpLFxuICBhcGk6IHJlcXVpcmUoJy4vYXBpJyksXG4gIGFzeW5jOiByZXF1aXJlKCcuL2FzeW5jJyksXG4gIFN0YXRlOiB1dGlsLnN0YXRlU2hvcnRoYW5kLFxuXG4gIF91dGlsOiB1dGlsXG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IEFieXNzYTsiLCJcbid1c2Ugc3RyaWN0JztcblxudmFyIHV0aWwgPSB7fTtcblxudXRpbC5ub29wID0gZnVuY3Rpb24gKCkge307XG5cbnV0aWwuYXJyYXlUb09iamVjdCA9IGZ1bmN0aW9uIChhcnJheSkge1xuICByZXR1cm4gYXJyYXkucmVkdWNlKGZ1bmN0aW9uIChvYmosIGl0ZW0pIHtcbiAgICBvYmpbaXRlbV0gPSAxO1xuICAgIHJldHVybiBvYmo7XG4gIH0sIHt9KTtcbn07XG5cbnV0aWwub2JqZWN0VG9BcnJheSA9IGZ1bmN0aW9uIChvYmopIHtcbiAgdmFyIGFycmF5ID0gW107XG4gIGZvciAodmFyIGtleSBpbiBvYmopIGFycmF5LnB1c2gob2JqW2tleV0pO1xuICByZXR1cm4gYXJyYXk7XG59O1xuXG51dGlsLmNvcHlPYmplY3QgPSBmdW5jdGlvbiAob2JqKSB7XG4gIHZhciBjb3B5ID0ge307XG4gIGZvciAodmFyIGtleSBpbiBvYmopIGNvcHlba2V5XSA9IG9ialtrZXldO1xuICByZXR1cm4gY29weTtcbn07XG5cbnV0aWwubWVyZ2VPYmplY3RzID0gZnVuY3Rpb24gKHRvLCBmcm9tKSB7XG4gIGZvciAodmFyIGtleSBpbiBmcm9tKSB0b1trZXldID0gZnJvbVtrZXldO1xuICByZXR1cm4gdG87XG59O1xuXG51dGlsLm1hcFZhbHVlcyA9IGZ1bmN0aW9uIChvYmosIGZuKSB7XG4gIHZhciByZXN1bHQgPSB7fTtcbiAgZm9yICh2YXIga2V5IGluIG9iaikge1xuICAgIHJlc3VsdFtrZXldID0gZm4ob2JqW2tleV0pO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59O1xuXG4vKlxuKiBSZXR1cm4gdGhlIHNldCBvZiBhbGwgdGhlIGtleXMgdGhhdCBjaGFuZ2VkIChlaXRoZXIgYWRkZWQsIHJlbW92ZWQgb3IgbW9kaWZpZWQpLlxuKi9cbnV0aWwub2JqZWN0RGlmZiA9IGZ1bmN0aW9uIChvYmoxLCBvYmoyKSB7XG4gIHZhciB1cGRhdGUgPSB7fSxcbiAgICAgIGVudGVyID0ge30sXG4gICAgICBleGl0ID0ge30sXG4gICAgICBhbGwgPSB7fSxcbiAgICAgIG5hbWUsXG4gICAgICBvYmoxID0gb2JqMSB8fCB7fTtcblxuICBmb3IgKG5hbWUgaW4gb2JqMSkge1xuICAgIGlmICghKG5hbWUgaW4gb2JqMikpIGV4aXRbbmFtZV0gPSBhbGxbbmFtZV0gPSB0cnVlO2Vsc2UgaWYgKG9iajFbbmFtZV0gIT0gb2JqMltuYW1lXSkgdXBkYXRlW25hbWVdID0gYWxsW25hbWVdID0gdHJ1ZTtcbiAgfVxuXG4gIGZvciAobmFtZSBpbiBvYmoyKSB7XG4gICAgaWYgKCEobmFtZSBpbiBvYmoxKSkgZW50ZXJbbmFtZV0gPSBhbGxbbmFtZV0gPSB0cnVlO1xuICB9XG5cbiAgcmV0dXJuIHsgYWxsOiBhbGwsIHVwZGF0ZTogdXBkYXRlLCBlbnRlcjogZW50ZXIsIGV4aXQ6IGV4aXQgfTtcbn07XG5cbnV0aWwubWFrZU1lc3NhZ2UgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBtZXNzYWdlID0gYXJndW1lbnRzWzBdLFxuICAgICAgdG9rZW5zID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcblxuICBmb3IgKHZhciBpID0gMCwgbCA9IHRva2Vucy5sZW5ndGg7IGkgPCBsOyBpKyspIG1lc3NhZ2UgPSBtZXNzYWdlLnJlcGxhY2UoJ3snICsgaSArICd9JywgdG9rZW5zW2ldKTtcblxuICByZXR1cm4gbWVzc2FnZTtcbn07XG5cbnV0aWwucGFyc2VQYXRocyA9IGZ1bmN0aW9uIChwYXRoKSB7XG4gIHJldHVybiBwYXRoLnNwbGl0KCcvJykuZmlsdGVyKGZ1bmN0aW9uIChzdHIpIHtcbiAgICByZXR1cm4gc3RyLmxlbmd0aDtcbiAgfSkubWFwKGZ1bmN0aW9uIChzdHIpIHtcbiAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KHN0cik7XG4gIH0pO1xufTtcblxudXRpbC5wYXJzZVF1ZXJ5UGFyYW1zID0gZnVuY3Rpb24gKHF1ZXJ5KSB7XG4gIHJldHVybiBxdWVyeSA/IHF1ZXJ5LnNwbGl0KCcmJykucmVkdWNlKGZ1bmN0aW9uIChyZXMsIHBhcmFtVmFsdWUpIHtcbiAgICB2YXIgcHYgPSBwYXJhbVZhbHVlLnNwbGl0KCc9Jyk7XG4gICAgcmVzW3B2WzBdXSA9IGRlY29kZVVSSUNvbXBvbmVudChwdlsxXSk7XG4gICAgcmV0dXJuIHJlcztcbiAgfSwge30pIDoge307XG59O1xuXG52YXIgTEVBRElOR19TTEFTSEVTID0gL15cXC8rLztcbnZhciBUUkFJTElOR19TTEFTSEVTID0gL14oW14/XSo/KVxcLyskLztcbnZhciBUUkFJTElOR19TTEFTSEVTX0JFRk9SRV9RVUVSWSA9IC9cXC8rXFw/LztcbnV0aWwubm9ybWFsaXplUGF0aFF1ZXJ5ID0gZnVuY3Rpb24gKHBhdGhRdWVyeSkge1xuICByZXR1cm4gJy8nICsgcGF0aFF1ZXJ5LnJlcGxhY2UoTEVBRElOR19TTEFTSEVTLCAnJykucmVwbGFjZShUUkFJTElOR19TTEFTSEVTLCAnJDEnKS5yZXBsYWNlKFRSQUlMSU5HX1NMQVNIRVNfQkVGT1JFX1FVRVJZLCAnPycpO1xufTtcblxudXRpbC5zdGF0ZVNob3J0aGFuZCA9IGZ1bmN0aW9uICh1cmksIG9wdGlvbnMsIGNoaWxkcmVuKSB7XG4gIHJldHVybiB1dGlsLm1lcmdlT2JqZWN0cyh7IHVyaTogdXJpLCBjaGlsZHJlbjogY2hpbGRyZW4gfHwge30gfSwgb3B0aW9ucyk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IHV0aWw7IiwiLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbmZ1bmN0aW9uIEV2ZW50RW1pdHRlcigpIHtcbiAgdGhpcy5fZXZlbnRzID0gdGhpcy5fZXZlbnRzIHx8IHt9O1xuICB0aGlzLl9tYXhMaXN0ZW5lcnMgPSB0aGlzLl9tYXhMaXN0ZW5lcnMgfHwgdW5kZWZpbmVkO1xufVxubW9kdWxlLmV4cG9ydHMgPSBFdmVudEVtaXR0ZXI7XG5cbi8vIEJhY2t3YXJkcy1jb21wYXQgd2l0aCBub2RlIDAuMTAueFxuRXZlbnRFbWl0dGVyLkV2ZW50RW1pdHRlciA9IEV2ZW50RW1pdHRlcjtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5fZXZlbnRzID0gdW5kZWZpbmVkO1xuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5fbWF4TGlzdGVuZXJzID0gdW5kZWZpbmVkO1xuXG4vLyBCeSBkZWZhdWx0IEV2ZW50RW1pdHRlcnMgd2lsbCBwcmludCBhIHdhcm5pbmcgaWYgbW9yZSB0aGFuIDEwIGxpc3RlbmVycyBhcmVcbi8vIGFkZGVkIHRvIGl0LiBUaGlzIGlzIGEgdXNlZnVsIGRlZmF1bHQgd2hpY2ggaGVscHMgZmluZGluZyBtZW1vcnkgbGVha3MuXG5FdmVudEVtaXR0ZXIuZGVmYXVsdE1heExpc3RlbmVycyA9IDEwO1xuXG4vLyBPYnZpb3VzbHkgbm90IGFsbCBFbWl0dGVycyBzaG91bGQgYmUgbGltaXRlZCB0byAxMC4gVGhpcyBmdW5jdGlvbiBhbGxvd3Ncbi8vIHRoYXQgdG8gYmUgaW5jcmVhc2VkLiBTZXQgdG8gemVybyBmb3IgdW5saW1pdGVkLlxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5zZXRNYXhMaXN0ZW5lcnMgPSBmdW5jdGlvbihuKSB7XG4gIGlmICghaXNOdW1iZXIobikgfHwgbiA8IDAgfHwgaXNOYU4obikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCduIG11c3QgYmUgYSBwb3NpdGl2ZSBudW1iZXInKTtcbiAgdGhpcy5fbWF4TGlzdGVuZXJzID0gbjtcbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmVtaXQgPSBmdW5jdGlvbih0eXBlKSB7XG4gIHZhciBlciwgaGFuZGxlciwgbGVuLCBhcmdzLCBpLCBsaXN0ZW5lcnM7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHMpXG4gICAgdGhpcy5fZXZlbnRzID0ge307XG5cbiAgLy8gSWYgdGhlcmUgaXMgbm8gJ2Vycm9yJyBldmVudCBsaXN0ZW5lciB0aGVuIHRocm93LlxuICBpZiAodHlwZSA9PT0gJ2Vycm9yJykge1xuICAgIGlmICghdGhpcy5fZXZlbnRzLmVycm9yIHx8XG4gICAgICAgIChpc09iamVjdCh0aGlzLl9ldmVudHMuZXJyb3IpICYmICF0aGlzLl9ldmVudHMuZXJyb3IubGVuZ3RoKSkge1xuICAgICAgZXIgPSBhcmd1bWVudHNbMV07XG4gICAgICBpZiAoZXIgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgICB0aHJvdyBlcjsgLy8gVW5oYW5kbGVkICdlcnJvcicgZXZlbnRcbiAgICAgIH1cbiAgICAgIHRocm93IFR5cGVFcnJvcignVW5jYXVnaHQsIHVuc3BlY2lmaWVkIFwiZXJyb3JcIiBldmVudC4nKTtcbiAgICB9XG4gIH1cblxuICBoYW5kbGVyID0gdGhpcy5fZXZlbnRzW3R5cGVdO1xuXG4gIGlmIChpc1VuZGVmaW5lZChoYW5kbGVyKSlcbiAgICByZXR1cm4gZmFsc2U7XG5cbiAgaWYgKGlzRnVuY3Rpb24oaGFuZGxlcikpIHtcbiAgICBzd2l0Y2ggKGFyZ3VtZW50cy5sZW5ndGgpIHtcbiAgICAgIC8vIGZhc3QgY2FzZXNcbiAgICAgIGNhc2UgMTpcbiAgICAgICAgaGFuZGxlci5jYWxsKHRoaXMpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMjpcbiAgICAgICAgaGFuZGxlci5jYWxsKHRoaXMsIGFyZ3VtZW50c1sxXSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAzOlxuICAgICAgICBoYW5kbGVyLmNhbGwodGhpcywgYXJndW1lbnRzWzFdLCBhcmd1bWVudHNbMl0pO1xuICAgICAgICBicmVhaztcbiAgICAgIC8vIHNsb3dlclxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgbGVuID0gYXJndW1lbnRzLmxlbmd0aDtcbiAgICAgICAgYXJncyA9IG5ldyBBcnJheShsZW4gLSAxKTtcbiAgICAgICAgZm9yIChpID0gMTsgaSA8IGxlbjsgaSsrKVxuICAgICAgICAgIGFyZ3NbaSAtIDFdID0gYXJndW1lbnRzW2ldO1xuICAgICAgICBoYW5kbGVyLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChpc09iamVjdChoYW5kbGVyKSkge1xuICAgIGxlbiA9IGFyZ3VtZW50cy5sZW5ndGg7XG4gICAgYXJncyA9IG5ldyBBcnJheShsZW4gLSAxKTtcbiAgICBmb3IgKGkgPSAxOyBpIDwgbGVuOyBpKyspXG4gICAgICBhcmdzW2kgLSAxXSA9IGFyZ3VtZW50c1tpXTtcblxuICAgIGxpc3RlbmVycyA9IGhhbmRsZXIuc2xpY2UoKTtcbiAgICBsZW4gPSBsaXN0ZW5lcnMubGVuZ3RoO1xuICAgIGZvciAoaSA9IDA7IGkgPCBsZW47IGkrKylcbiAgICAgIGxpc3RlbmVyc1tpXS5hcHBseSh0aGlzLCBhcmdzKTtcbiAgfVxuXG4gIHJldHVybiB0cnVlO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5hZGRMaXN0ZW5lciA9IGZ1bmN0aW9uKHR5cGUsIGxpc3RlbmVyKSB7XG4gIHZhciBtO1xuXG4gIGlmICghaXNGdW5jdGlvbihsaXN0ZW5lcikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCdsaXN0ZW5lciBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcblxuICBpZiAoIXRoaXMuX2V2ZW50cylcbiAgICB0aGlzLl9ldmVudHMgPSB7fTtcblxuICAvLyBUbyBhdm9pZCByZWN1cnNpb24gaW4gdGhlIGNhc2UgdGhhdCB0eXBlID09PSBcIm5ld0xpc3RlbmVyXCIhIEJlZm9yZVxuICAvLyBhZGRpbmcgaXQgdG8gdGhlIGxpc3RlbmVycywgZmlyc3QgZW1pdCBcIm5ld0xpc3RlbmVyXCIuXG4gIGlmICh0aGlzLl9ldmVudHMubmV3TGlzdGVuZXIpXG4gICAgdGhpcy5lbWl0KCduZXdMaXN0ZW5lcicsIHR5cGUsXG4gICAgICAgICAgICAgIGlzRnVuY3Rpb24obGlzdGVuZXIubGlzdGVuZXIpID9cbiAgICAgICAgICAgICAgbGlzdGVuZXIubGlzdGVuZXIgOiBsaXN0ZW5lcik7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgLy8gT3B0aW1pemUgdGhlIGNhc2Ugb2Ygb25lIGxpc3RlbmVyLiBEb24ndCBuZWVkIHRoZSBleHRyYSBhcnJheSBvYmplY3QuXG4gICAgdGhpcy5fZXZlbnRzW3R5cGVdID0gbGlzdGVuZXI7XG4gIGVsc2UgaWYgKGlzT2JqZWN0KHRoaXMuX2V2ZW50c1t0eXBlXSkpXG4gICAgLy8gSWYgd2UndmUgYWxyZWFkeSBnb3QgYW4gYXJyYXksIGp1c3QgYXBwZW5kLlxuICAgIHRoaXMuX2V2ZW50c1t0eXBlXS5wdXNoKGxpc3RlbmVyKTtcbiAgZWxzZVxuICAgIC8vIEFkZGluZyB0aGUgc2Vjb25kIGVsZW1lbnQsIG5lZWQgdG8gY2hhbmdlIHRvIGFycmF5LlxuICAgIHRoaXMuX2V2ZW50c1t0eXBlXSA9IFt0aGlzLl9ldmVudHNbdHlwZV0sIGxpc3RlbmVyXTtcblxuICAvLyBDaGVjayBmb3IgbGlzdGVuZXIgbGVha1xuICBpZiAoaXNPYmplY3QodGhpcy5fZXZlbnRzW3R5cGVdKSAmJiAhdGhpcy5fZXZlbnRzW3R5cGVdLndhcm5lZCkge1xuICAgIHZhciBtO1xuICAgIGlmICghaXNVbmRlZmluZWQodGhpcy5fbWF4TGlzdGVuZXJzKSkge1xuICAgICAgbSA9IHRoaXMuX21heExpc3RlbmVycztcbiAgICB9IGVsc2Uge1xuICAgICAgbSA9IEV2ZW50RW1pdHRlci5kZWZhdWx0TWF4TGlzdGVuZXJzO1xuICAgIH1cblxuICAgIGlmIChtICYmIG0gPiAwICYmIHRoaXMuX2V2ZW50c1t0eXBlXS5sZW5ndGggPiBtKSB7XG4gICAgICB0aGlzLl9ldmVudHNbdHlwZV0ud2FybmVkID0gdHJ1ZTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJyhub2RlKSB3YXJuaW5nOiBwb3NzaWJsZSBFdmVudEVtaXR0ZXIgbWVtb3J5ICcgK1xuICAgICAgICAgICAgICAgICAgICAnbGVhayBkZXRlY3RlZC4gJWQgbGlzdGVuZXJzIGFkZGVkLiAnICtcbiAgICAgICAgICAgICAgICAgICAgJ1VzZSBlbWl0dGVyLnNldE1heExpc3RlbmVycygpIHRvIGluY3JlYXNlIGxpbWl0LicsXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50c1t0eXBlXS5sZW5ndGgpO1xuICAgICAgaWYgKHR5cGVvZiBjb25zb2xlLnRyYWNlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIC8vIG5vdCBzdXBwb3J0ZWQgaW4gSUUgMTBcbiAgICAgICAgY29uc29sZS50cmFjZSgpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5vbiA9IEV2ZW50RW1pdHRlci5wcm90b3R5cGUuYWRkTGlzdGVuZXI7XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUub25jZSA9IGZ1bmN0aW9uKHR5cGUsIGxpc3RlbmVyKSB7XG4gIGlmICghaXNGdW5jdGlvbihsaXN0ZW5lcikpXG4gICAgdGhyb3cgVHlwZUVycm9yKCdsaXN0ZW5lciBtdXN0IGJlIGEgZnVuY3Rpb24nKTtcblxuICB2YXIgZmlyZWQgPSBmYWxzZTtcblxuICBmdW5jdGlvbiBnKCkge1xuICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIodHlwZSwgZyk7XG5cbiAgICBpZiAoIWZpcmVkKSB7XG4gICAgICBmaXJlZCA9IHRydWU7XG4gICAgICBsaXN0ZW5lci5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH1cbiAgfVxuXG4gIGcubGlzdGVuZXIgPSBsaXN0ZW5lcjtcbiAgdGhpcy5vbih0eXBlLCBnKTtcblxuICByZXR1cm4gdGhpcztcbn07XG5cbi8vIGVtaXRzIGEgJ3JlbW92ZUxpc3RlbmVyJyBldmVudCBpZmYgdGhlIGxpc3RlbmVyIHdhcyByZW1vdmVkXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnJlbW92ZUxpc3RlbmVyID0gZnVuY3Rpb24odHlwZSwgbGlzdGVuZXIpIHtcbiAgdmFyIGxpc3QsIHBvc2l0aW9uLCBsZW5ndGgsIGk7XG5cbiAgaWYgKCFpc0Z1bmN0aW9uKGxpc3RlbmVyKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ2xpc3RlbmVyIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzIHx8ICF0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgcmV0dXJuIHRoaXM7XG5cbiAgbGlzdCA9IHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgbGVuZ3RoID0gbGlzdC5sZW5ndGg7XG4gIHBvc2l0aW9uID0gLTE7XG5cbiAgaWYgKGxpc3QgPT09IGxpc3RlbmVyIHx8XG4gICAgICAoaXNGdW5jdGlvbihsaXN0Lmxpc3RlbmVyKSAmJiBsaXN0Lmxpc3RlbmVyID09PSBsaXN0ZW5lcikpIHtcbiAgICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuICAgIGlmICh0aGlzLl9ldmVudHMucmVtb3ZlTGlzdGVuZXIpXG4gICAgICB0aGlzLmVtaXQoJ3JlbW92ZUxpc3RlbmVyJywgdHlwZSwgbGlzdGVuZXIpO1xuXG4gIH0gZWxzZSBpZiAoaXNPYmplY3QobGlzdCkpIHtcbiAgICBmb3IgKGkgPSBsZW5ndGg7IGktLSA+IDA7KSB7XG4gICAgICBpZiAobGlzdFtpXSA9PT0gbGlzdGVuZXIgfHxcbiAgICAgICAgICAobGlzdFtpXS5saXN0ZW5lciAmJiBsaXN0W2ldLmxpc3RlbmVyID09PSBsaXN0ZW5lcikpIHtcbiAgICAgICAgcG9zaXRpb24gPSBpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAocG9zaXRpb24gPCAwKVxuICAgICAgcmV0dXJuIHRoaXM7XG5cbiAgICBpZiAobGlzdC5sZW5ndGggPT09IDEpIHtcbiAgICAgIGxpc3QubGVuZ3RoID0gMDtcbiAgICAgIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG4gICAgfSBlbHNlIHtcbiAgICAgIGxpc3Quc3BsaWNlKHBvc2l0aW9uLCAxKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5fZXZlbnRzLnJlbW92ZUxpc3RlbmVyKVxuICAgICAgdGhpcy5lbWl0KCdyZW1vdmVMaXN0ZW5lcicsIHR5cGUsIGxpc3RlbmVyKTtcbiAgfVxuXG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBmdW5jdGlvbih0eXBlKSB7XG4gIHZhciBrZXksIGxpc3RlbmVycztcblxuICBpZiAoIXRoaXMuX2V2ZW50cylcbiAgICByZXR1cm4gdGhpcztcblxuICAvLyBub3QgbGlzdGVuaW5nIGZvciByZW1vdmVMaXN0ZW5lciwgbm8gbmVlZCB0byBlbWl0XG4gIGlmICghdGhpcy5fZXZlbnRzLnJlbW92ZUxpc3RlbmVyKSB7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApXG4gICAgICB0aGlzLl9ldmVudHMgPSB7fTtcbiAgICBlbHNlIGlmICh0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8gZW1pdCByZW1vdmVMaXN0ZW5lciBmb3IgYWxsIGxpc3RlbmVycyBvbiBhbGwgZXZlbnRzXG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgZm9yIChrZXkgaW4gdGhpcy5fZXZlbnRzKSB7XG4gICAgICBpZiAoa2V5ID09PSAncmVtb3ZlTGlzdGVuZXInKSBjb250aW51ZTtcbiAgICAgIHRoaXMucmVtb3ZlQWxsTGlzdGVuZXJzKGtleSk7XG4gICAgfVxuICAgIHRoaXMucmVtb3ZlQWxsTGlzdGVuZXJzKCdyZW1vdmVMaXN0ZW5lcicpO1xuICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgbGlzdGVuZXJzID0gdGhpcy5fZXZlbnRzW3R5cGVdO1xuXG4gIGlmIChpc0Z1bmN0aW9uKGxpc3RlbmVycykpIHtcbiAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGxpc3RlbmVycyk7XG4gIH0gZWxzZSB7XG4gICAgLy8gTElGTyBvcmRlclxuICAgIHdoaWxlIChsaXN0ZW5lcnMubGVuZ3RoKVxuICAgICAgdGhpcy5yZW1vdmVMaXN0ZW5lcih0eXBlLCBsaXN0ZW5lcnNbbGlzdGVuZXJzLmxlbmd0aCAtIDFdKTtcbiAgfVxuICBkZWxldGUgdGhpcy5fZXZlbnRzW3R5cGVdO1xuXG4gIHJldHVybiB0aGlzO1xufTtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5saXN0ZW5lcnMgPSBmdW5jdGlvbih0eXBlKSB7XG4gIHZhciByZXQ7XG4gIGlmICghdGhpcy5fZXZlbnRzIHx8ICF0aGlzLl9ldmVudHNbdHlwZV0pXG4gICAgcmV0ID0gW107XG4gIGVsc2UgaWYgKGlzRnVuY3Rpb24odGhpcy5fZXZlbnRzW3R5cGVdKSlcbiAgICByZXQgPSBbdGhpcy5fZXZlbnRzW3R5cGVdXTtcbiAgZWxzZVxuICAgIHJldCA9IHRoaXMuX2V2ZW50c1t0eXBlXS5zbGljZSgpO1xuICByZXR1cm4gcmV0O1xufTtcblxuRXZlbnRFbWl0dGVyLmxpc3RlbmVyQ291bnQgPSBmdW5jdGlvbihlbWl0dGVyLCB0eXBlKSB7XG4gIHZhciByZXQ7XG4gIGlmICghZW1pdHRlci5fZXZlbnRzIHx8ICFlbWl0dGVyLl9ldmVudHNbdHlwZV0pXG4gICAgcmV0ID0gMDtcbiAgZWxzZSBpZiAoaXNGdW5jdGlvbihlbWl0dGVyLl9ldmVudHNbdHlwZV0pKVxuICAgIHJldCA9IDE7XG4gIGVsc2VcbiAgICByZXQgPSBlbWl0dGVyLl9ldmVudHNbdHlwZV0ubGVuZ3RoO1xuICByZXR1cm4gcmV0O1xufTtcblxuZnVuY3Rpb24gaXNGdW5jdGlvbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdmdW5jdGlvbic7XG59XG5cbmZ1bmN0aW9uIGlzTnVtYmVyKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ251bWJlcic7XG59XG5cbmZ1bmN0aW9uIGlzT2JqZWN0KGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ29iamVjdCcgJiYgYXJnICE9PSBudWxsO1xufVxuXG5mdW5jdGlvbiBpc1VuZGVmaW5lZChhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gdm9pZCAwO1xufVxuIiwiaW1wb3J0IHsgcGFyc2VIVE1MLCBsb2FkUGFnZSB9IGZyb20gJy4vZG9tLmpzJztcblxuXG5mdW5jdGlvbiBhamF4KHVybCkge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGxldCB4aHIgPSBuZXcgWE1MSHR0cFJlcXVlc3QoKTtcbiAgXG4gICAgeGhyLm9wZW4oJ0dFVCcsIHdpbmRvdy5sb2NhdGlvbi5vcmlnaW4gKyB1cmwpO1xuICAgIHhoci5vbmxvYWQgPSAoKSA9PiB7XG4gICAgICBpZiAoeGhyLnN0YXR1cyA9PSAyMDApXG4gICAgICAgIHJlc29sdmUocGFyc2VIVE1MKHhoci5yZXNwb25zZVRleHQpKTtcbiAgICAgIGVsc2VcbiAgICAgICAgcmVqZWN0KEVycm9yKHhoci5zdGF0dXNUZXh0KSk7XG4gICAgfTtcbiAgICB4aHIub25lcnJvciA9ICgpID0+IHtcbiAgICAgIHJlamVjdChFcnJvcignTmV0d29yayBFcnJvcicpKTtcbiAgICB9O1xuICAgIHhoci5zZW5kKCk7XG4gIH0pO1xufVxuXG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRIb21lKCkgeyBcbiAgYWpheCgnLycpLnRoZW4ocmVzID0+IGxvYWRQYWdlKHJlcykpIFxufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UG9zdChpZCkgeyBcbiAgYWpheCgnLycrIGlkKS50aGVuKHJlcyA9PiBsb2FkUGFnZShyZXMpKSBcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFRhZyhpZCkgeyBcbiAgYWpheCgnL3RhZy8nKyBpZCkudGhlbihyZXMgPT4gbG9hZFBhZ2UocmVzKSkgXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRBdXRob3IoaWQpIHsgXG4gIGFqYXgoJy9hdXRob3IvJysgaWQpLnRoZW4ocmVzID0+IGxvYWRQYWdlKHJlcykpIFxufSIsIlxuLy8gR2V0IHBhcnNlZCBodG1sIGZyb20geGhyXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VIVE1MKHN0cikge1xuICBsZXQgdG1wWE1MID0gZG9jdW1lbnQuaW1wbGVtZW50YXRpb24uY3JlYXRlSFRNTERvY3VtZW50KCk7XG4gIHRtcFhNTC5ib2R5LmlubmVySFRNTCA9IHN0cjtcbiAgbGV0IGJvZHlYTUwgPSB0bXBYTUwuYm9keS5jaGlsZHJlbjtcblxuICBmb3IgKGxldCBpIGluIGJvZHlYTUwpIHtcbiAgICBsZXQgJHdyYXAgPSBib2R5WE1MW2ldLnF1ZXJ5U2VsZWN0b3IoJyN3cmFwJyk7XG4gICAgaWYgKCR3cmFwICE9PSBudWxsKSByZXR1cm4gJHdyYXA7XG4gIH1cbn1cblxuLy8gSW5qZWN0IGVsZW1lbnQncyBodG1sIGluIHdyYXBwZXJcbmV4cG9ydCBmdW5jdGlvbiBsb2FkUGFnZShlbGVtZW50KSB7XG4gIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyNjb250ZW50JykuaW5uZXJIVE1MID0gZWxlbWVudC5pbm5lckhUTUw7XG59IiwiaW1wb3J0IGEgZnJvbSAnYWJ5c3NhJztcblxuaW1wb3J0IHsgZ2V0SG9tZSwgZ2V0UG9zdCwgZ2V0VGFnLCBnZXRBdXRob3IgfSBmcm9tICcuL3V0aWxzL2FqYXgnO1xuXG5cbmxldCBSb3V0ZXIgPSBhLlJvdXRlcih7XG4gIGluZGV4OiBhLlN0YXRlKCcvJywge1xuICAgIGVudGVyOiAocGFyYW1zKSA9PiB7XG4gICAgICBpZiAoIVJvdXRlci5pc0ZpcnN0VHJhbnNpdGlvbigpKSBjb25zb2xlLmxvZygndGVzdCcpO1xuICAgIH1cbiAgICAvLyBleGl0OiAoKSA9PiBjb25zb2xlLmxvZygnbGVhdmUgaG9tZScpXG4gIH0se1xuICAgIGhvbWU6IGEuU3RhdGUoJycsIHtcbiAgICAgIGVudGVyOiAocGFyYW1zKSA9PiB7IFxuICAgICAgICBpZiAoIVJvdXRlci5pc0ZpcnN0VHJhbnNpdGlvbigpKSBnZXRIb21lKClcbiAgICAgIH1cbiAgICAgIC8vIGV4aXQ6ICgpID0+IGNvbnNvbGUubG9nKCdsZWF2ZSBob21lJylcbiAgICB9KSxcbiAgICBwb3N0OiBhLlN0YXRlKCc6aWQnLCB7XG4gICAgICBlbnRlcjogKHBhcmFtcykgPT4geyBcbiAgICAgICAgaWYgKCFSb3V0ZXIuaXNGaXJzdFRyYW5zaXRpb24oKSkgZ2V0UG9zdChwYXJhbXMuaWQpXG4gICAgICB9XG4gICAgICAvLyBleGl0OiAoKSA9PiBjb25zb2xlLmxvZygnbGVhdmUgcG9zdCcpXG4gICAgfSlcbiAgfSksXG4gIHRhZzogYS5TdGF0ZSgndGFnLzppZCcsIHtcbiAgICBlbnRlcjogKHBhcmFtcykgPT4geyBcbiAgICAgIGlmICghUm91dGVyLmlzRmlyc3RUcmFuc2l0aW9uKCkpIGdldFRhZyhwYXJhbXMuaWQpXG4gICAgfVxuICAgIC8vIGV4aXQ6ICgpID0+IGNvbnNvbGUubG9nKCdsZWF2ZSB0YWcnKVxuICB9KSxcbiAgYXV0aG9yOiBhLlN0YXRlKCdhdXRob3IvOmlkJywge1xuICAgIGVudGVyOiAocGFyYW1zKSA9PiB7IFxuICAgICAgaWYgKCFSb3V0ZXIuaXNGaXJzdFRyYW5zaXRpb24oKSkgZ2V0QXV0aG9yKHBhcmFtcy5pZClcbiAgICB9XG4gICAgLy8gZXhpdDogKCkgPT4gY29uc29sZS5sb2coJ2xlYXZlIGF1dGhvcicpXG4gIH0pXG59KTtcblxuUm91dGVyLmluaXQoKTsiXX0=
