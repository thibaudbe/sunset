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
exports.ajax = ajax;

function ajax(options) {
  var method = options.method;
  var url = options.url;
  var data = options.data;

  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();

    xhr.open(method, window.location.origin + url);
    xhr.onload = function () {
      if (xhr.status == 200) resolve(xhr.responseText);else reject(Error(xhr.statusText));
    };
    xhr.onerror = function () {
      reject(Error('Network Error'));
    };
    xhr.send(data);
  });
}

},{}],12:[function(require,module,exports){
'use strict';

function _interopRequireDefault(obj) {
  return obj && obj.__esModule ? obj : { 'default': obj };
}

var _abyssa = require('abyssa');

var _abyssa2 = _interopRequireDefault(_abyssa);

var _utilsAjax = require('./utils/ajax');

var _utilsAjax2 = _interopRequireDefault(_utilsAjax);

console.log('dat work');

var router = _abyssa2['default'].Router({
  home: _abyssa2['default'].State('/', {
    enter: function enter(params) {
      console.log('enter home', params.id);
    },
    exit: function exit() {
      console.log('leave home');
    }
  }, {
    post: _abyssa2['default'].State(':id', {
      enter: function enter(params) {
        console.log('enter post', params.id);
        // ajax(params.id, res => res);
      },
      exit: function exit() {
        console.log('leave post');
      }
    })
  }),
  tag: _abyssa2['default'].State('tag/:id', {
    enter: function enter(params) {
      console.log('enter tag', 'tag/' + params.id);
    },
    exit: function exit() {
      console.log('leave tag');
    }
  }),
  author: _abyssa2['default'].State('author/:id', {
    enter: function enter(params) {
      console.log('enter author', 'author/' + params.id);
    },
    exit: function exit() {
      console.log('leave author');
    }
  })
}).init();

},{"./utils/ajax":11,"abyssa":8}]},{},[12])
//# sourceMappingURL=data:application/json;charset:utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJub2RlX21vZHVsZXMvYWJ5c3NhL2xpYi9Sb3V0ZXIuanMiLCJub2RlX21vZHVsZXMvYWJ5c3NhL2xpYi9TdGF0ZS5qcyIsIm5vZGVfbW9kdWxlcy9hYnlzc2EvbGliL1N0YXRlV2l0aFBhcmFtcy5qcyIsIm5vZGVfbW9kdWxlcy9hYnlzc2EvbGliL1RyYW5zaXRpb24uanMiLCJub2RlX21vZHVsZXMvYWJ5c3NhL2xpYi9hbmNob3JzLmpzIiwibm9kZV9tb2R1bGVzL2FieXNzYS9saWIvYXBpLmpzIiwibm9kZV9tb2R1bGVzL2FieXNzYS9saWIvYXN5bmMuanMiLCJub2RlX21vZHVsZXMvYWJ5c3NhL2xpYi9tYWluLmpzIiwibm9kZV9tb2R1bGVzL2FieXNzYS9saWIvdXRpbC5qcyIsIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9ldmVudHMvZXZlbnRzLmpzIiwiL1VzZXJzL3Riby9Eb2N1bWVudHMvR2l0aHViL2dob3N0LXRoZW1lL2NvbnRlbnQvdGhlbWVzL3N1bnNldC9zcmMvanMvdXRpbHMvYWpheC5qcyIsIi9Vc2Vycy90Ym8vRG9jdW1lbnRzL0dpdGh1Yi9naG9zdC10aGVtZS9jb250ZW50L3RoZW1lcy9zdW5zZXQvc3JjL2pzL2luZGV4LmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6aUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDek5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN1NBLFlBQVksQ0FBQzs7QUFFYixNQUFNLENBQUMsY0FBYyxDQUFDLE9BQU8sRUFBRSxZQUFZLEVBQUU7QUFDM0MsT0FBSyxFQUFFLElBQUk7Q0FDWixDQUFDLENBQUM7QUFDSCxPQUFPLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQzs7QUFMYixTQUFTLElBQUksQ0FBQyxPQUFPLEVBQUU7QUFRNUIsTUFQTSxNQUFNLEdBQWdCLE9BQU8sQ0FBN0IsTUFBTSxDQUFBO0FBUVosTUFSYyxHQUFHLEdBQVcsT0FBTyxDQUFyQixHQUFHLENBQUE7QUFTakIsTUFUbUIsSUFBSSxHQUFLLE9BQU8sQ0FBaEIsSUFBSSxDQUFBOztBQUV2QixTQUFPLElBQUksT0FBTyxDQUFDLFVBQUMsT0FBTyxFQUFFLE1BQU0sRUFBSztBQUN0QyxRQUFJLEdBQUcsR0FBRyxJQUFJLGNBQWMsRUFBRSxDQUFDOztBQUUvQixPQUFHLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLE1BQU0sR0FBRyxHQUFHLENBQUMsQ0FBQztBQUMvQyxPQUFHLENBQUMsTUFBTSxHQUFHLFlBQU07QUFDakIsVUFBSSxHQUFHLENBQUMsTUFBTSxJQUFJLEdBQUcsRUFDbkIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFZLENBQUMsQ0FBQyxLQUUxQixNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDO0tBQ2pDLENBQUM7QUFDRixPQUFHLENBQUMsT0FBTyxHQUFHLFlBQU07QUFDbEIsWUFBTSxDQUFDLEtBQUssQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDO0tBQ2hDLENBQUM7QUFDRixPQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0dBQ2hCLENBQUMsQ0FBQztDQUNKOzs7QUNsQkQsWUFBWSxDQUFDOztBQUViLFNBQVMsc0JBQXNCLENBQUMsR0FBRyxFQUFFO0FBQUUsU0FBTyxHQUFHLElBQUksR0FBRyxDQUFDLFVBQVUsR0FBRyxHQUFHLEdBQUcsRUFBRSxTQUFTLEVBQUUsR0FBRyxFQUFFLENBQUM7Q0FBRTs7QUFFakcsSUFBSSxPQUFPLEdBQUcsT0FBTyxDQUZQLFFBQVEsQ0FBQSxDQUFBOztBQUl0QixJQUFJLFFBQVEsR0FBRyxzQkFBc0IsQ0FBQyxPQUFPLENBQUMsQ0FBQzs7QUFFL0MsSUFBSSxVQUFVLEdBQUcsT0FBTyxDQUxQLGNBQWMsQ0FBQSxDQUFBOztBQU8vQixJQUFJLFdBQVcsR0FBRyxzQkFBc0IsQ0FBQyxVQUFVLENBQUMsQ0FBQzs7QUFWckQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQzs7QUFNeEIsSUFBSSxNQUFNLEdBQUcsUUFBQSxDQUFBLFNBQUEsQ0FBQSxDQUFFLE1BQU0sQ0FBQztBQUNwQixNQUFJLEVBQUUsUUFBQSxDQUFBLFNBQUEsQ0FBQSxDQUFFLEtBQUssQ0FBQyxHQUFHLEVBQUU7QUFDakIsU0FBSyxFQUFFLFNBQUEsS0FBQSxDQUFTLE1BQU0sRUFBRTtBQUN0QixhQUFPLENBQUMsR0FBRyxDQUFDLFlBQVksRUFBRSxNQUFNLENBQUMsRUFBRSxDQUFDLENBQUM7S0FDdEM7QUFDRCxRQUFJLEVBQUUsU0FBQSxJQUFBLEdBQVc7QUFDZixhQUFPLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxDQUFDO0tBQzNCO0dBQ0YsRUFBQztBQUNBLFFBQUksRUFBRSxRQUFBLENBQUEsU0FBQSxDQUFBLENBQUUsS0FBSyxDQUFDLEtBQUssRUFBRTtBQUNuQixXQUFLLEVBQUUsU0FBQSxLQUFBLENBQVMsTUFBTSxFQUFFO0FBQ3RCLGVBQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxFQUFFLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQzs7T0FFdEM7QUFDRCxVQUFJLEVBQUUsU0FBQSxJQUFBLEdBQVc7QUFDZixlQUFPLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxDQUFDO09BQzNCO0tBQ0YsQ0FBQztHQUNILENBQUM7QUFDRixLQUFHLEVBQUUsUUFBQSxDQUFBLFNBQUEsQ0FBQSxDQUFFLEtBQUssQ0FBQyxTQUFTLEVBQUU7QUFDdEIsU0FBSyxFQUFFLFNBQUEsS0FBQSxDQUFTLE1BQU0sRUFBRTtBQUN0QixhQUFPLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSxNQUFNLEdBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0tBQzdDO0FBQ0QsUUFBSSxFQUFFLFNBQUEsSUFBQSxHQUFXO0FBQ2YsYUFBTyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQztLQUMxQjtHQUNGLENBQUM7QUFDRixRQUFNLEVBQUUsUUFBQSxDQUFBLFNBQUEsQ0FBQSxDQUFFLEtBQUssQ0FBQyxZQUFZLEVBQUU7QUFDNUIsU0FBSyxFQUFFLFNBQUEsS0FBQSxDQUFTLE1BQU0sRUFBRTtBQUN0QixhQUFPLENBQUMsR0FBRyxDQUFDLGNBQWMsRUFBRSxTQUFTLEdBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0tBQ25EO0FBQ0QsUUFBSSxFQUFFLFNBQUEsSUFBQSxHQUFXO0FBQ2YsYUFBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjLENBQUMsQ0FBQztLQUM3QjtHQUNGLENBQUM7Q0FDSCxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiXG4ndXNlIHN0cmljdCc7XG5cbnZhciBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKSxcbiAgICBpbnRlcmNlcHRBbmNob3JzID0gcmVxdWlyZSgnLi9hbmNob3JzJyksXG4gICAgU3RhdGVXaXRoUGFyYW1zID0gcmVxdWlyZSgnLi9TdGF0ZVdpdGhQYXJhbXMnKSxcbiAgICBUcmFuc2l0aW9uID0gcmVxdWlyZSgnLi9UcmFuc2l0aW9uJyksXG4gICAgdXRpbCA9IHJlcXVpcmUoJy4vdXRpbCcpLFxuICAgIFN0YXRlID0gcmVxdWlyZSgnLi9TdGF0ZScpLFxuICAgIGFwaSA9IHJlcXVpcmUoJy4vYXBpJyk7XG5cbi8qXG4qIENyZWF0ZSBhIG5ldyBSb3V0ZXIgaW5zdGFuY2UsIHBhc3NpbmcgYW55IHN0YXRlIGRlZmluZWQgZGVjbGFyYXRpdmVseS5cbiogTW9yZSBzdGF0ZXMgY2FuIGJlIGFkZGVkIHVzaW5nIGFkZFN0YXRlKCkuXG4qXG4qIEJlY2F1c2UgYSByb3V0ZXIgbWFuYWdlcyBnbG9iYWwgc3RhdGUgKHRoZSBVUkwpLCBvbmx5IG9uZSBpbnN0YW5jZSBvZiBSb3V0ZXJcbiogc2hvdWxkIGJlIHVzZWQgaW5zaWRlIGFuIGFwcGxpY2F0aW9uLlxuKi9cbmZ1bmN0aW9uIFJvdXRlcihkZWNsYXJhdGl2ZVN0YXRlcykge1xuICB2YXIgcm91dGVyID0ge30sXG4gICAgICBzdGF0ZXMgPSBzdGF0ZVRyZWVzKGRlY2xhcmF0aXZlU3RhdGVzKSxcbiAgICAgIGZpcnN0VHJhbnNpdGlvbiA9IHRydWUsXG4gICAgICBvcHRpb25zID0ge1xuICAgIGVuYWJsZUxvZ3M6IGZhbHNlLFxuICAgIGludGVyY2VwdEFuY2hvcnM6IHRydWUsXG4gICAgbm90Rm91bmQ6IG51bGwsXG4gICAgdXJsU3luYzogdHJ1ZSxcbiAgICBoYXNoUHJlZml4OiAnJ1xuICB9LFxuICAgICAgaWdub3JlTmV4dFVSTENoYW5nZSA9IGZhbHNlLFxuICAgICAgY3VycmVudFBhdGhRdWVyeSxcbiAgICAgIGN1cnJlbnRQYXJhbXNEaWZmID0ge30sXG4gICAgICBjdXJyZW50U3RhdGUsXG4gICAgICBwcmV2aW91c1N0YXRlLFxuICAgICAgdHJhbnNpdGlvbixcbiAgICAgIGxlYWZTdGF0ZXMsXG4gICAgICB1cmxDaGFuZ2VkLFxuICAgICAgaW5pdGlhbGl6ZWQsXG4gICAgICBoYXNoU2xhc2hTdHJpbmc7XG5cbiAgLypcbiAgKiBTZXR0aW5nIGEgbmV3IHN0YXRlIHdpbGwgc3RhcnQgYSB0cmFuc2l0aW9uIGZyb20gdGhlIGN1cnJlbnQgc3RhdGUgdG8gdGhlIHRhcmdldCBzdGF0ZS5cbiAgKiBBIHN1Y2Nlc3NmdWwgdHJhbnNpdGlvbiB3aWxsIHJlc3VsdCBpbiB0aGUgVVJMIGJlaW5nIGNoYW5nZWQuXG4gICogQSBmYWlsZWQgdHJhbnNpdGlvbiB3aWxsIGxlYXZlIHRoZSByb3V0ZXIgaW4gaXRzIGN1cnJlbnQgc3RhdGUuXG4gICovXG4gIGZ1bmN0aW9uIHNldFN0YXRlKHN0YXRlLCBwYXJhbXMsIGFjYykge1xuICAgIHZhciBmcm9tU3RhdGUgPSB0cmFuc2l0aW9uID8gU3RhdGVXaXRoUGFyYW1zKHRyYW5zaXRpb24uY3VycmVudFN0YXRlLCB0cmFuc2l0aW9uLnRvUGFyYW1zKSA6IGN1cnJlbnRTdGF0ZTtcblxuICAgIHZhciB0b1N0YXRlID0gU3RhdGVXaXRoUGFyYW1zKHN0YXRlLCBwYXJhbXMpO1xuICAgIHZhciBkaWZmID0gdXRpbC5vYmplY3REaWZmKGZyb21TdGF0ZSAmJiBmcm9tU3RhdGUucGFyYW1zLCBwYXJhbXMpO1xuXG4gICAgaWYgKHByZXZlbnRUcmFuc2l0aW9uKGZyb21TdGF0ZSwgdG9TdGF0ZSwgZGlmZikpIHtcbiAgICAgIGlmICh0cmFuc2l0aW9uICYmIHRyYW5zaXRpb24uZXhpdGluZykgY2FuY2VsVHJhbnNpdGlvbigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICh0cmFuc2l0aW9uKSBjYW5jZWxUcmFuc2l0aW9uKCk7XG5cbiAgICAvLyBXaGlsZSB0aGUgdHJhbnNpdGlvbiBpcyBydW5uaW5nLCBhbnkgY29kZSBhc2tpbmcgdGhlIHJvdXRlciBhYm91dCB0aGUgcHJldmlvdXMvY3VycmVudCBzdGF0ZSBzaG91bGRcbiAgICAvLyBnZXQgdGhlIGVuZCByZXN1bHQgc3RhdGUuXG4gICAgcHJldmlvdXNTdGF0ZSA9IGN1cnJlbnRTdGF0ZTtcbiAgICBjdXJyZW50U3RhdGUgPSB0b1N0YXRlO1xuICAgIGN1cnJlbnRQYXJhbXNEaWZmID0gZGlmZjtcblxuICAgIHRyYW5zaXRpb24gPSBUcmFuc2l0aW9uKGZyb21TdGF0ZSwgdG9TdGF0ZSwgZGlmZiwgYWNjLCByb3V0ZXIsIGxvZ2dlcik7XG5cbiAgICBzdGFydGluZ1RyYW5zaXRpb24oZnJvbVN0YXRlLCB0b1N0YXRlKTtcblxuICAgIC8vIEluIGNhc2Ugb2YgYSByZWRpcmVjdCgpIGNhbGxlZCBmcm9tICdzdGFydGluZ1RyYW5zaXRpb24nLCB0aGUgdHJhbnNpdGlvbiBhbHJlYWR5IGVuZGVkLlxuICAgIGlmICh0cmFuc2l0aW9uKSB0cmFuc2l0aW9uLnJ1bigpO1xuXG4gICAgLy8gSW4gY2FzZSBvZiBhIHJlZGlyZWN0KCkgY2FsbGVkIGZyb20gdGhlIHRyYW5zaXRpb24gaXRzZWxmLCB0aGUgdHJhbnNpdGlvbiBhbHJlYWR5IGVuZGVkXG4gICAgaWYgKHRyYW5zaXRpb24pIHtcbiAgICAgIGlmICh0cmFuc2l0aW9uLmNhbmNlbGxlZCkgY3VycmVudFN0YXRlID0gZnJvbVN0YXRlO2Vsc2UgZW5kaW5nVHJhbnNpdGlvbihmcm9tU3RhdGUsIHRvU3RhdGUpO1xuICAgIH1cblxuICAgIHRyYW5zaXRpb24gPSBudWxsO1xuICB9XG5cbiAgZnVuY3Rpb24gY2FuY2VsVHJhbnNpdGlvbigpIHtcbiAgICBsb2dnZXIubG9nKCdDYW5jZWxsaW5nIGV4aXN0aW5nIHRyYW5zaXRpb24gZnJvbSB7MH0gdG8gezF9JywgdHJhbnNpdGlvbi5mcm9tLCB0cmFuc2l0aW9uLnRvKTtcblxuICAgIHRyYW5zaXRpb24uY2FuY2VsKCk7XG5cbiAgICBmaXJzdFRyYW5zaXRpb24gPSBmYWxzZTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHN0YXJ0aW5nVHJhbnNpdGlvbihmcm9tU3RhdGUsIHRvU3RhdGUpIHtcbiAgICBsb2dnZXIubG9nKCdTdGFydGluZyB0cmFuc2l0aW9uIGZyb20gezB9IHRvIHsxfScsIGZyb21TdGF0ZSwgdG9TdGF0ZSk7XG5cbiAgICB2YXIgZnJvbSA9IGZyb21TdGF0ZSA/IGZyb21TdGF0ZS5hc1B1YmxpYyA6IG51bGw7XG4gICAgdmFyIHRvID0gdG9TdGF0ZS5hc1B1YmxpYztcblxuICAgIHJvdXRlci50cmFuc2l0aW9uLmVtaXQoJ3N0YXJ0ZWQnLCB0bywgZnJvbSk7XG4gIH1cblxuICBmdW5jdGlvbiBlbmRpbmdUcmFuc2l0aW9uKGZyb21TdGF0ZSwgdG9TdGF0ZSkge1xuICAgIGlmICghdXJsQ2hhbmdlZCAmJiAhZmlyc3RUcmFuc2l0aW9uKSB7XG4gICAgICBsb2dnZXIubG9nKCdVcGRhdGluZyBVUkw6IHswfScsIGN1cnJlbnRQYXRoUXVlcnkpO1xuICAgICAgdXBkYXRlVVJMRnJvbVN0YXRlKGN1cnJlbnRQYXRoUXVlcnksIGRvY3VtZW50LnRpdGxlLCBjdXJyZW50UGF0aFF1ZXJ5KTtcbiAgICB9XG5cbiAgICBmaXJzdFRyYW5zaXRpb24gPSBmYWxzZTtcblxuICAgIGxvZ2dlci5sb2coJ1RyYW5zaXRpb24gZnJvbSB7MH0gdG8gezF9IGVuZGVkJywgZnJvbVN0YXRlLCB0b1N0YXRlKTtcblxuICAgIHRvU3RhdGUuc3RhdGUubGFzdFBhcmFtcyA9IHRvU3RhdGUucGFyYW1zO1xuXG4gICAgdmFyIGZyb20gPSBmcm9tU3RhdGUgPyBmcm9tU3RhdGUuYXNQdWJsaWMgOiBudWxsO1xuICAgIHZhciB0byA9IHRvU3RhdGUuYXNQdWJsaWM7XG4gICAgcm91dGVyLnRyYW5zaXRpb24uZW1pdCgnZW5kZWQnLCB0bywgZnJvbSk7XG4gIH1cblxuICBmdW5jdGlvbiB1cGRhdGVVUkxGcm9tU3RhdGUoc3RhdGUsIHRpdGxlLCB1cmwpIHtcbiAgICBpZiAoaXNIYXNoTW9kZSgpKSB7XG4gICAgICBpZ25vcmVOZXh0VVJMQ2hhbmdlID0gdHJ1ZTtcbiAgICAgIGxvY2F0aW9uLmhhc2ggPSBvcHRpb25zLmhhc2hQcmVmaXggKyB1cmw7XG4gICAgfSBlbHNlIGhpc3RvcnkucHVzaFN0YXRlKHN0YXRlLCB0aXRsZSwgdXJsKTtcbiAgfVxuXG4gIC8qXG4gICogUmV0dXJuIHdoZXRoZXIgdGhlIHBhc3NlZCBzdGF0ZSBpcyB0aGUgc2FtZSBhcyB0aGUgY3VycmVudCBvbmU7XG4gICogaW4gd2hpY2ggY2FzZSB0aGUgcm91dGVyIGNhbiBpZ25vcmUgdGhlIGNoYW5nZS5cbiAgKi9cbiAgZnVuY3Rpb24gcHJldmVudFRyYW5zaXRpb24oY3VycmVudCwgbmV3U3RhdGUsIGRpZmYpIHtcbiAgICBpZiAoIWN1cnJlbnQpIHJldHVybiBmYWxzZTtcblxuICAgIHJldHVybiBuZXdTdGF0ZS5zdGF0ZSA9PSBjdXJyZW50LnN0YXRlICYmIE9iamVjdC5rZXlzKGRpZmYuYWxsKS5sZW5ndGggPT0gMDtcbiAgfVxuXG4gIC8qXG4gICogVGhlIHN0YXRlIHdhc24ndCBmb3VuZDtcbiAgKiBUcmFuc2l0aW9uIHRvIHRoZSAnbm90Rm91bmQnIHN0YXRlIGlmIHRoZSBkZXZlbG9wZXIgc3BlY2lmaWVkIGl0IG9yIGVsc2UgdGhyb3cgYW4gZXJyb3IuXG4gICovXG4gIGZ1bmN0aW9uIG5vdEZvdW5kKHN0YXRlKSB7XG4gICAgbG9nZ2VyLmxvZygnU3RhdGUgbm90IGZvdW5kOiB7MH0nLCBzdGF0ZSk7XG5cbiAgICBpZiAob3B0aW9ucy5ub3RGb3VuZCkgcmV0dXJuIHNldFN0YXRlKGxlYWZTdGF0ZXNbb3B0aW9ucy5ub3RGb3VuZF0sIHt9KTtlbHNlIHRocm93IG5ldyBFcnJvcignU3RhdGUgXCInICsgc3RhdGUgKyAnXCIgY291bGQgbm90IGJlIGZvdW5kJyk7XG4gIH1cblxuICAvKlxuICAqIENvbmZpZ3VyZSB0aGUgcm91dGVyIGJlZm9yZSBpdHMgaW5pdGlhbGl6YXRpb24uXG4gICogVGhlIGF2YWlsYWJsZSBvcHRpb25zIGFyZTpcbiAgKiAgIGVuYWJsZUxvZ3M6IFdoZXRoZXIgKGRlYnVnIGFuZCBlcnJvcikgY29uc29sZSBsb2dzIHNob3VsZCBiZSBlbmFibGVkLiBEZWZhdWx0cyB0byBmYWxzZS5cbiAgKiAgIGludGVyY2VwdEFuY2hvcnM6IFdoZXRoZXIgYW5jaG9yIG1vdXNlZG93bi9jbGlja3Mgc2hvdWxkIGJlIGludGVyY2VwdGVkIGFuZCB0cmlnZ2VyIGEgc3RhdGUgY2hhbmdlLiBEZWZhdWx0cyB0byB0cnVlLlxuICAqICAgbm90Rm91bmQ6IFRoZSBTdGF0ZSB0byBlbnRlciB3aGVuIG5vIHN0YXRlIG1hdGNoaW5nIHRoZSBjdXJyZW50IHBhdGggcXVlcnkgb3IgbmFtZSBjb3VsZCBiZSBmb3VuZC4gRGVmYXVsdHMgdG8gbnVsbC5cbiAgKiAgIHVybFN5bmM6IEhvdyBzaG91bGQgdGhlIHJvdXRlciBtYWludGFpbiB0aGUgY3VycmVudCBzdGF0ZSBhbmQgdGhlIHVybCBpbiBzeW5jLiBEZWZhdWx0cyB0byB0cnVlIChoaXN0b3J5IEFQSSkuXG4gICogICBoYXNoUHJlZml4OiBDdXN0b21pemUgdGhlIGhhc2ggc2VwYXJhdG9yLiBTZXQgdG8gJyEnIGluIG9yZGVyIHRvIGhhdmUgYSBoYXNoYmFuZyBsaWtlICcvIyEvJy4gRGVmYXVsdHMgdG8gZW1wdHkgc3RyaW5nLlxuICAqL1xuICBmdW5jdGlvbiBjb25maWd1cmUod2l0aE9wdGlvbnMpIHtcbiAgICB1dGlsLm1lcmdlT2JqZWN0cyhvcHRpb25zLCB3aXRoT3B0aW9ucyk7XG4gICAgcmV0dXJuIHJvdXRlcjtcbiAgfVxuXG4gIC8qXG4gICogSW5pdGlhbGl6ZSB0aGUgcm91dGVyLlxuICAqIFRoZSByb3V0ZXIgd2lsbCBpbW1lZGlhdGVseSBpbml0aWF0ZSBhIHRyYW5zaXRpb24gdG8sIGluIG9yZGVyIG9mIHByaW9yaXR5OlxuICAqIDEpIFRoZSBpbml0IHN0YXRlIHBhc3NlZCBhcyBhbiBhcmd1bWVudFxuICAqIDIpIFRoZSBzdGF0ZSBjYXB0dXJlZCBieSB0aGUgY3VycmVudCBVUkxcbiAgKi9cbiAgZnVuY3Rpb24gaW5pdChpbml0U3RhdGUsIGluaXRQYXJhbXMpIHtcbiAgICBpZiAob3B0aW9ucy5lbmFibGVMb2dzKSBSb3V0ZXIuZW5hYmxlTG9ncygpO1xuXG4gICAgaWYgKG9wdGlvbnMuaW50ZXJjZXB0QW5jaG9ycykgaW50ZXJjZXB0QW5jaG9ycyhyb3V0ZXIpO1xuXG4gICAgaGFzaFNsYXNoU3RyaW5nID0gJyMnICsgb3B0aW9ucy5oYXNoUHJlZml4ICsgJy8nO1xuXG4gICAgbG9nZ2VyLmxvZygnUm91dGVyIGluaXQnKTtcblxuICAgIGluaXRTdGF0ZXMoKTtcbiAgICBsb2dTdGF0ZVRyZWUoKTtcblxuICAgIGluaXRTdGF0ZSA9IGluaXRTdGF0ZSAhPT0gdW5kZWZpbmVkID8gaW5pdFN0YXRlIDogdXJsUGF0aFF1ZXJ5KCk7XG5cbiAgICBsb2dnZXIubG9nKCdJbml0aWFsaXppbmcgdG8gc3RhdGUgezB9JywgaW5pdFN0YXRlIHx8ICdcIlwiJyk7XG4gICAgdHJhbnNpdGlvblRvKGluaXRTdGF0ZSwgaW5pdFBhcmFtcyk7XG5cbiAgICBsaXN0ZW5Ub1VSTENoYW5nZXMoKTtcblxuICAgIGluaXRpYWxpemVkID0gdHJ1ZTtcbiAgICByZXR1cm4gcm91dGVyO1xuICB9XG5cbiAgLypcbiAgKiBSZW1vdmUgYW55IHBvc3NpYmlsaXR5IG9mIHNpZGUgZWZmZWN0IHRoaXMgcm91dGVyIGluc3RhbmNlIG1pZ2h0IGNhdXNlLlxuICAqIFVzZWQgZm9yIHRlc3RpbmcgcHVycG9zZXMuXG4gICovXG4gIGZ1bmN0aW9uIHRlcm1pbmF0ZSgpIHtcbiAgICB3aW5kb3cub25oYXNoY2hhbmdlID0gbnVsbDtcbiAgICB3aW5kb3cub25wb3BzdGF0ZSA9IG51bGw7XG4gIH1cblxuICBmdW5jdGlvbiBsaXN0ZW5Ub1VSTENoYW5nZXMoKSB7XG5cbiAgICBmdW5jdGlvbiBvblVSTENoYW5nZShldnQpIHtcbiAgICAgIGlmIChpZ25vcmVOZXh0VVJMQ2hhbmdlKSB7XG4gICAgICAgIGlnbm9yZU5leHRVUkxDaGFuZ2UgPSBmYWxzZTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICB2YXIgbmV3U3RhdGUgPSBldnQuc3RhdGUgfHwgdXJsUGF0aFF1ZXJ5KCk7XG5cbiAgICAgIGxvZ2dlci5sb2coJ1VSTCBjaGFuZ2VkOiB7MH0nLCBuZXdTdGF0ZSk7XG4gICAgICB1cmxDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIHNldFN0YXRlRm9yUGF0aFF1ZXJ5KG5ld1N0YXRlKTtcbiAgICB9XG5cbiAgICB3aW5kb3dbaXNIYXNoTW9kZSgpID8gJ29uaGFzaGNoYW5nZScgOiAnb25wb3BzdGF0ZSddID0gb25VUkxDaGFuZ2U7XG4gIH1cblxuICBmdW5jdGlvbiBpbml0U3RhdGVzKCkge1xuICAgIHZhciBzdGF0ZUFycmF5ID0gdXRpbC5vYmplY3RUb0FycmF5KHN0YXRlcyk7XG5cbiAgICBhZGREZWZhdWx0U3RhdGVzKHN0YXRlQXJyYXkpO1xuXG4gICAgZWFjaFJvb3RTdGF0ZShmdW5jdGlvbiAobmFtZSwgc3RhdGUpIHtcbiAgICAgIHN0YXRlLmluaXQocm91dGVyLCBuYW1lKTtcbiAgICB9KTtcblxuICAgIGFzc2VydFBhdGhVbmlxdWVuZXNzKHN0YXRlQXJyYXkpO1xuXG4gICAgbGVhZlN0YXRlcyA9IHJlZ2lzdGVyTGVhZlN0YXRlcyhzdGF0ZUFycmF5LCB7fSk7XG5cbiAgICBhc3NlcnROb0FtYmlndW91c1BhdGhzKCk7XG4gIH1cblxuICBmdW5jdGlvbiBhc3NlcnRQYXRoVW5pcXVlbmVzcyhzdGF0ZXMpIHtcbiAgICB2YXIgcGF0aHMgPSB7fTtcblxuICAgIHN0YXRlcy5mb3JFYWNoKGZ1bmN0aW9uIChzdGF0ZSkge1xuICAgICAgaWYgKHBhdGhzW3N0YXRlLnBhdGhdKSB7XG4gICAgICAgIHZhciBmdWxsUGF0aHMgPSBzdGF0ZXMubWFwKGZ1bmN0aW9uIChzKSB7XG4gICAgICAgICAgcmV0dXJuIHMuZnVsbFBhdGgoKSB8fCAnZW1wdHknO1xuICAgICAgICB9KTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUd28gc2libGluZyBzdGF0ZXMgaGF2ZSB0aGUgc2FtZSBwYXRoICgnICsgZnVsbFBhdGhzICsgJyknKTtcbiAgICAgIH1cblxuICAgICAgcGF0aHNbc3RhdGUucGF0aF0gPSAxO1xuICAgICAgYXNzZXJ0UGF0aFVuaXF1ZW5lc3Moc3RhdGUuY2hpbGRyZW4pO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gYXNzZXJ0Tm9BbWJpZ3VvdXNQYXRocygpIHtcbiAgICB2YXIgcGF0aHMgPSB7fTtcblxuICAgIGZvciAodmFyIG5hbWUgaW4gbGVhZlN0YXRlcykge1xuICAgICAgdmFyIHBhdGggPSB1dGlsLm5vcm1hbGl6ZVBhdGhRdWVyeShsZWFmU3RhdGVzW25hbWVdLmZ1bGxQYXRoKCkpO1xuICAgICAgaWYgKHBhdGhzW3BhdGhdKSB0aHJvdyBuZXcgRXJyb3IoJ0FtYmlndW91cyBzdGF0ZSBwYXRoczogJyArIHBhdGgpO1xuICAgICAgcGF0aHNbcGF0aF0gPSAxO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGFkZERlZmF1bHRTdGF0ZXMoc3RhdGVzKSB7XG4gICAgc3RhdGVzLmZvckVhY2goZnVuY3Rpb24gKHN0YXRlKSB7XG4gICAgICB2YXIgY2hpbGRyZW4gPSB1dGlsLm9iamVjdFRvQXJyYXkoc3RhdGUuc3RhdGVzKTtcblxuICAgICAgLy8gVGhpcyBpcyBhIHBhcmVudCBzdGF0ZTogQWRkIGEgZGVmYXVsdCBzdGF0ZSB0byBpdCBpZiB0aGVyZSBpc24ndCBhbHJlYWR5IG9uZVxuICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCkge1xuICAgICAgICBhZGREZWZhdWx0U3RhdGVzKGNoaWxkcmVuKTtcblxuICAgICAgICB2YXIgaGFzRGVmYXVsdFN0YXRlID0gY2hpbGRyZW4ucmVkdWNlKGZ1bmN0aW9uIChyZXN1bHQsIHN0YXRlKSB7XG4gICAgICAgICAgcmV0dXJuIHN0YXRlLnBhdGggPT0gJycgfHwgcmVzdWx0O1xuICAgICAgICB9LCBmYWxzZSk7XG5cbiAgICAgICAgaWYgKGhhc0RlZmF1bHRTdGF0ZSkgcmV0dXJuO1xuXG4gICAgICAgIHZhciBkZWZhdWx0U3RhdGUgPSBTdGF0ZSh7IHVyaTogJycgfSk7XG4gICAgICAgIHN0YXRlLnN0YXRlcy5fZGVmYXVsdF8gPSBkZWZhdWx0U3RhdGU7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBlYWNoUm9vdFN0YXRlKGNhbGxiYWNrKSB7XG4gICAgZm9yICh2YXIgbmFtZSBpbiBzdGF0ZXMpIGNhbGxiYWNrKG5hbWUsIHN0YXRlc1tuYW1lXSk7XG4gIH1cblxuICBmdW5jdGlvbiByZWdpc3RlckxlYWZTdGF0ZXMoc3RhdGVzLCBsZWFmU3RhdGVzKSB7XG4gICAgcmV0dXJuIHN0YXRlcy5yZWR1Y2UoZnVuY3Rpb24gKGxlYWZTdGF0ZXMsIHN0YXRlKSB7XG4gICAgICBpZiAoc3RhdGUuY2hpbGRyZW4ubGVuZ3RoKSByZXR1cm4gcmVnaXN0ZXJMZWFmU3RhdGVzKHN0YXRlLmNoaWxkcmVuLCBsZWFmU3RhdGVzKTtlbHNlIHtcbiAgICAgICAgbGVhZlN0YXRlc1tzdGF0ZS5mdWxsTmFtZV0gPSBzdGF0ZTtcbiAgICAgICAgc3RhdGUucGF0aHMgPSB1dGlsLnBhcnNlUGF0aHMoc3RhdGUuZnVsbFBhdGgoKSk7XG4gICAgICAgIHJldHVybiBsZWFmU3RhdGVzO1xuICAgICAgfVxuICAgIH0sIGxlYWZTdGF0ZXMpO1xuICB9XG5cbiAgLypcbiAgKiBSZXF1ZXN0IGEgcHJvZ3JhbW1hdGljIHN0YXRlIGNoYW5nZS5cbiAgKlxuICAqIFR3byBub3RhdGlvbnMgYXJlIHN1cHBvcnRlZDpcbiAgKiB0cmFuc2l0aW9uVG8oJ215LnRhcmdldC5zdGF0ZScsIHtpZDogMzMsIGZpbHRlcjogJ2Rlc2MnfSlcbiAgKiB0cmFuc2l0aW9uVG8oJ3RhcmdldC8zMz9maWx0ZXI9ZGVzYycpXG4gICovXG4gIGZ1bmN0aW9uIHRyYW5zaXRpb25UbyhwYXRoUXVlcnlPck5hbWUpIHtcbiAgICB2YXIgbmFtZSA9IGxlYWZTdGF0ZXNbcGF0aFF1ZXJ5T3JOYW1lXTtcbiAgICB2YXIgcGFyYW1zID0gKG5hbWUgPyBhcmd1bWVudHNbMV0gOiBudWxsKSB8fCB7fTtcbiAgICB2YXIgYWNjID0gbmFtZSA/IGFyZ3VtZW50c1syXSA6IGFyZ3VtZW50c1sxXTtcblxuICAgIGxvZ2dlci5sb2coJ0NoYW5naW5nIHN0YXRlIHRvIHswfScsIHBhdGhRdWVyeU9yTmFtZSB8fCAnXCJcIicpO1xuXG4gICAgdXJsQ2hhbmdlZCA9IGZhbHNlO1xuXG4gICAgaWYgKG5hbWUpIHNldFN0YXRlQnlOYW1lKG5hbWUsIHBhcmFtcywgYWNjKTtlbHNlIHNldFN0YXRlRm9yUGF0aFF1ZXJ5KHBhdGhRdWVyeU9yTmFtZSwgYWNjKTtcbiAgfVxuXG4gIC8qXG4gICogQXR0ZW1wdCB0byBuYXZpZ2F0ZSB0byAnc3RhdGVOYW1lJyB3aXRoIGl0cyBwcmV2aW91cyBwYXJhbXMgb3JcbiAgKiBmYWxsYmFjayB0byB0aGUgZGVmYXVsdFBhcmFtcyBwYXJhbWV0ZXIgaWYgdGhlIHN0YXRlIHdhcyBuZXZlciBlbnRlcmVkLlxuICAqL1xuICBmdW5jdGlvbiBiYWNrVG8oc3RhdGVOYW1lLCBkZWZhdWx0UGFyYW1zLCBhY2MpIHtcbiAgICB2YXIgcGFyYW1zID0gbGVhZlN0YXRlc1tzdGF0ZU5hbWVdLmxhc3RQYXJhbXMgfHwgZGVmYXVsdFBhcmFtcztcbiAgICB0cmFuc2l0aW9uVG8oc3RhdGVOYW1lLCBwYXJhbXMsIGFjYyk7XG4gIH1cblxuICBmdW5jdGlvbiBzZXRTdGF0ZUZvclBhdGhRdWVyeShwYXRoUXVlcnksIGFjYykge1xuICAgIHZhciBzdGF0ZSwgcGFyYW1zLCBfc3RhdGUsIF9wYXJhbXM7XG5cbiAgICBjdXJyZW50UGF0aFF1ZXJ5ID0gdXRpbC5ub3JtYWxpemVQYXRoUXVlcnkocGF0aFF1ZXJ5KTtcblxuICAgIHZhciBwcSA9IGN1cnJlbnRQYXRoUXVlcnkuc3BsaXQoJz8nKTtcbiAgICB2YXIgcGF0aCA9IHBxWzBdO1xuICAgIHZhciBxdWVyeSA9IHBxWzFdO1xuICAgIHZhciBwYXRocyA9IHV0aWwucGFyc2VQYXRocyhwYXRoKTtcbiAgICB2YXIgcXVlcnlQYXJhbXMgPSB1dGlsLnBhcnNlUXVlcnlQYXJhbXMocXVlcnkpO1xuXG4gICAgZm9yICh2YXIgbmFtZSBpbiBsZWFmU3RhdGVzKSB7XG4gICAgICBfc3RhdGUgPSBsZWFmU3RhdGVzW25hbWVdO1xuICAgICAgX3BhcmFtcyA9IF9zdGF0ZS5tYXRjaGVzKHBhdGhzKTtcblxuICAgICAgaWYgKF9wYXJhbXMpIHtcbiAgICAgICAgc3RhdGUgPSBfc3RhdGU7XG4gICAgICAgIHBhcmFtcyA9IHV0aWwubWVyZ2VPYmplY3RzKF9wYXJhbXMsIHF1ZXJ5UGFyYW1zKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHN0YXRlKSBzZXRTdGF0ZShzdGF0ZSwgcGFyYW1zLCBhY2MpO2Vsc2Ugbm90Rm91bmQoY3VycmVudFBhdGhRdWVyeSk7XG4gIH1cblxuICBmdW5jdGlvbiBzZXRTdGF0ZUJ5TmFtZShuYW1lLCBwYXJhbXMsIGFjYykge1xuICAgIHZhciBzdGF0ZSA9IGxlYWZTdGF0ZXNbbmFtZV07XG5cbiAgICBpZiAoIXN0YXRlKSByZXR1cm4gbm90Rm91bmQobmFtZSk7XG5cbiAgICB2YXIgcGF0aFF1ZXJ5ID0gaW50ZXJwb2xhdGUoc3RhdGUsIHBhcmFtcyk7XG4gICAgc2V0U3RhdGVGb3JQYXRoUXVlcnkocGF0aFF1ZXJ5LCBhY2MpO1xuICB9XG5cbiAgLypcbiAgKiBBZGQgYSBuZXcgcm9vdCBzdGF0ZSB0byB0aGUgcm91dGVyLlxuICAqIFRoZSBuYW1lIG11c3QgYmUgdW5pcXVlIGFtb25nIHJvb3Qgc3RhdGVzLlxuICAqL1xuICBmdW5jdGlvbiBhZGRTdGF0ZShuYW1lLCBzdGF0ZSkge1xuICAgIGlmIChzdGF0ZXNbbmFtZV0pIHRocm93IG5ldyBFcnJvcignQSBzdGF0ZSBhbHJlYWR5IGV4aXN0IGluIHRoZSByb3V0ZXIgd2l0aCB0aGUgbmFtZSAnICsgbmFtZSk7XG5cbiAgICBzdGF0ZSA9IHN0YXRlVHJlZShzdGF0ZSk7XG5cbiAgICBzdGF0ZXNbbmFtZV0gPSBzdGF0ZTtcblxuICAgIGlmIChpbml0aWFsaXplZCkge1xuICAgICAgc3RhdGUuaW5pdChyb3V0ZXIsIG5hbWUpO1xuICAgICAgcmVnaXN0ZXJMZWFmU3RhdGVzKHsgXzogc3RhdGUgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJvdXRlcjtcbiAgfVxuXG4gIC8qXG4gICogUmVhZCB0aGUgcGF0aC9xdWVyeSBmcm9tIHRoZSBVUkwuXG4gICovXG4gIGZ1bmN0aW9uIHVybFBhdGhRdWVyeSgpIHtcbiAgICB2YXIgaGFzaFNsYXNoID0gbG9jYXRpb24uaHJlZi5pbmRleE9mKGhhc2hTbGFzaFN0cmluZyk7XG4gICAgdmFyIHBhdGhRdWVyeTtcblxuICAgIGlmIChoYXNoU2xhc2ggPiAtMSkgcGF0aFF1ZXJ5ID0gbG9jYXRpb24uaHJlZi5zbGljZShoYXNoU2xhc2ggKyBoYXNoU2xhc2hTdHJpbmcubGVuZ3RoKTtlbHNlIGlmIChpc0hhc2hNb2RlKCkpIHBhdGhRdWVyeSA9ICcvJztlbHNlIHBhdGhRdWVyeSA9IChsb2NhdGlvbi5wYXRobmFtZSArIGxvY2F0aW9uLnNlYXJjaCkuc2xpY2UoMSk7XG5cbiAgICByZXR1cm4gdXRpbC5ub3JtYWxpemVQYXRoUXVlcnkocGF0aFF1ZXJ5KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGlzSGFzaE1vZGUoKSB7XG4gICAgcmV0dXJuIG9wdGlvbnMudXJsU3luYyA9PSAnaGFzaCc7XG4gIH1cblxuICAvKlxuICAqIENvbXB1dGUgYSBsaW5rIHRoYXQgY2FuIGJlIHVzZWQgaW4gYW5jaG9ycycgaHJlZiBhdHRyaWJ1dGVzXG4gICogZnJvbSBhIHN0YXRlIG5hbWUgYW5kIGEgbGlzdCBvZiBwYXJhbXMsIGEuay5hIHJldmVyc2Ugcm91dGluZy5cbiAgKi9cbiAgZnVuY3Rpb24gbGluayhzdGF0ZU5hbWUsIHBhcmFtcykge1xuICAgIHZhciBzdGF0ZSA9IGxlYWZTdGF0ZXNbc3RhdGVOYW1lXTtcbiAgICBpZiAoIXN0YXRlKSB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCBmaW5kIHN0YXRlICcgKyBzdGF0ZU5hbWUpO1xuXG4gICAgdmFyIGludGVycG9sYXRlZCA9IGludGVycG9sYXRlKHN0YXRlLCBwYXJhbXMpO1xuICAgIHZhciB1cmkgPSB1dGlsLm5vcm1hbGl6ZVBhdGhRdWVyeShpbnRlcnBvbGF0ZWQpO1xuXG4gICAgcmV0dXJuIGlzSGFzaE1vZGUoKSA/ICcjJyArIG9wdGlvbnMuaGFzaFByZWZpeCArIHVyaSA6IHVyaTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGludGVycG9sYXRlKHN0YXRlLCBwYXJhbXMpIHtcbiAgICB2YXIgZW5jb2RlZFBhcmFtcyA9IHt9O1xuXG4gICAgZm9yICh2YXIga2V5IGluIHBhcmFtcykge1xuICAgICAgZW5jb2RlZFBhcmFtc1trZXldID0gZW5jb2RlVVJJQ29tcG9uZW50KHBhcmFtc1trZXldKTtcbiAgICB9XG5cbiAgICByZXR1cm4gc3RhdGUuaW50ZXJwb2xhdGUoZW5jb2RlZFBhcmFtcyk7XG4gIH1cblxuICAvKlxuICAqIFJldHVybnMgYW4gb2JqZWN0IHJlcHJlc2VudGluZyB0aGUgY3VycmVudCBzdGF0ZSBvZiB0aGUgcm91dGVyLlxuICAqL1xuICBmdW5jdGlvbiBnZXRDdXJyZW50KCkge1xuICAgIHJldHVybiBjdXJyZW50U3RhdGUgJiYgY3VycmVudFN0YXRlLmFzUHVibGljO1xuICB9XG5cbiAgLypcbiAgKiBSZXR1cm5zIGFuIG9iamVjdCByZXByZXNlbnRpbmcgdGhlIHByZXZpb3VzIHN0YXRlIG9mIHRoZSByb3V0ZXJcbiAgKiBvciBudWxsIGlmIHRoZSByb3V0ZXIgaXMgc3RpbGwgaW4gaXRzIGluaXRpYWwgc3RhdGUuXG4gICovXG4gIGZ1bmN0aW9uIGdldFByZXZpb3VzKCkge1xuICAgIHJldHVybiBwcmV2aW91c1N0YXRlICYmIHByZXZpb3VzU3RhdGUuYXNQdWJsaWM7XG4gIH1cblxuICAvKlxuICAqIFJldHVybnMgdGhlIGRpZmYgYmV0d2VlbiB0aGUgY3VycmVudCBwYXJhbXMgYW5kIHRoZSBwcmV2aW91cyBvbmVzLlxuICAqL1xuICBmdW5jdGlvbiBnZXRQYXJhbXNEaWZmKCkge1xuICAgIHJldHVybiBjdXJyZW50UGFyYW1zRGlmZjtcbiAgfVxuXG4gIGZ1bmN0aW9uIGFsbFN0YXRlc1JlYyhzdGF0ZXMsIGFjYykge1xuICAgIGFjYy5wdXNoLmFwcGx5KGFjYywgc3RhdGVzKTtcbiAgICBzdGF0ZXMuZm9yRWFjaChmdW5jdGlvbiAoc3RhdGUpIHtcbiAgICAgIHJldHVybiBhbGxTdGF0ZXNSZWMoc3RhdGUuY2hpbGRyZW4sIGFjYyk7XG4gICAgfSk7XG4gICAgcmV0dXJuIGFjYztcbiAgfVxuXG4gIGZ1bmN0aW9uIGFsbFN0YXRlcygpIHtcbiAgICByZXR1cm4gYWxsU3RhdGVzUmVjKHV0aWwub2JqZWN0VG9BcnJheShzdGF0ZXMpLCBbXSk7XG4gIH1cblxuICAvKlxuICAqIFJldHVybnMgdGhlIHN0YXRlIG9iamVjdCB0aGF0IHdhcyBidWlsdCB3aXRoIHRoZSBnaXZlbiBvcHRpb25zIG9iamVjdCBvciB0aGF0IGhhcyB0aGUgZ2l2ZW4gZnVsbE5hbWUuXG4gICogUmV0dXJucyB1bmRlZmluZWQgaWYgdGhlIHN0YXRlIGRvZXNuJ3QgZXhpc3QuXG4gICovXG4gIGZ1bmN0aW9uIGZpbmRTdGF0ZShieSkge1xuICAgIHZhciBmaWx0ZXJGbiA9IHR5cGVvZiBieSA9PT0gJ29iamVjdCcgPyBmdW5jdGlvbiAoc3RhdGUpIHtcbiAgICAgIHJldHVybiBieSA9PT0gc3RhdGUub3B0aW9ucztcbiAgICB9IDogZnVuY3Rpb24gKHN0YXRlKSB7XG4gICAgICByZXR1cm4gYnkgPT09IHN0YXRlLmZ1bGxOYW1lO1xuICAgIH07XG5cbiAgICB2YXIgc3RhdGUgPSBhbGxTdGF0ZXMoKS5maWx0ZXIoZmlsdGVyRm4pWzBdO1xuICAgIHJldHVybiBzdGF0ZSAmJiBzdGF0ZS5hc1B1YmxpYztcbiAgfVxuXG4gIC8qXG4gICogUmV0dXJucyB3aGV0aGVyIHRoZSByb3V0ZXIgaXMgZXhlY3V0aW5nIGl0cyBmaXJzdCB0cmFuc2l0aW9uLlxuICAqL1xuICBmdW5jdGlvbiBpc0ZpcnN0VHJhbnNpdGlvbigpIHtcbiAgICByZXR1cm4gcHJldmlvdXNTdGF0ZSA9PSBudWxsO1xuICB9XG5cbiAgZnVuY3Rpb24gc3RhdGVUcmVlcyhzdGF0ZXMpIHtcbiAgICByZXR1cm4gdXRpbC5tYXBWYWx1ZXMoc3RhdGVzLCBzdGF0ZVRyZWUpO1xuICB9XG5cbiAgLypcbiAgKiBDcmVhdGVzIGFuIGludGVybmFsIFN0YXRlIG9iamVjdCBmcm9tIGEgc3BlY2lmaWNhdGlvbiBQT0pPLlxuICAqL1xuICBmdW5jdGlvbiBzdGF0ZVRyZWUoc3RhdGUpIHtcbiAgICBpZiAoc3RhdGUuY2hpbGRyZW4pIHN0YXRlLmNoaWxkcmVuID0gc3RhdGVUcmVlcyhzdGF0ZS5jaGlsZHJlbik7XG4gICAgcmV0dXJuIFN0YXRlKHN0YXRlKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGxvZ1N0YXRlVHJlZSgpIHtcbiAgICBpZiAoIWxvZ2dlci5lbmFibGVkKSByZXR1cm47XG5cbiAgICB2YXIgaW5kZW50ID0gZnVuY3Rpb24gaW5kZW50KGxldmVsKSB7XG4gICAgICBpZiAobGV2ZWwgPT0gMCkgcmV0dXJuICcnO1xuICAgICAgcmV0dXJuIG5ldyBBcnJheSgyICsgKGxldmVsIC0gMSkgKiA0KS5qb2luKCcgJykgKyAn4pSA4pSAICc7XG4gICAgfTtcblxuICAgIHZhciBzdGF0ZVRyZWUgPSBmdW5jdGlvbiBzdGF0ZVRyZWUoc3RhdGUpIHtcbiAgICAgIHZhciBwYXRoID0gdXRpbC5ub3JtYWxpemVQYXRoUXVlcnkoc3RhdGUuZnVsbFBhdGgoKSk7XG4gICAgICB2YXIgcGF0aFN0ciA9IHN0YXRlLmNoaWxkcmVuLmxlbmd0aCA9PSAwID8gJyAoQCBwYXRoKScucmVwbGFjZSgncGF0aCcsIHBhdGgpIDogJyc7XG4gICAgICB2YXIgc3RyID0gaW5kZW50KHN0YXRlLnBhcmVudHMubGVuZ3RoKSArIHN0YXRlLm5hbWUgKyBwYXRoU3RyICsgJ1xcbic7XG4gICAgICByZXR1cm4gc3RyICsgc3RhdGUuY2hpbGRyZW4ubWFwKHN0YXRlVHJlZSkuam9pbignJyk7XG4gICAgfTtcblxuICAgIHZhciBtc2cgPSAnXFxuU3RhdGUgdHJlZVxcblxcbic7XG4gICAgbXNnICs9IHV0aWwub2JqZWN0VG9BcnJheShzdGF0ZXMpLm1hcChzdGF0ZVRyZWUpLmpvaW4oJycpO1xuICAgIG1zZyArPSAnXFxuJztcblxuICAgIGxvZ2dlci5sb2cobXNnKTtcbiAgfVxuXG4gIC8vIFB1YmxpYyBtZXRob2RzXG5cbiAgcm91dGVyLmNvbmZpZ3VyZSA9IGNvbmZpZ3VyZTtcbiAgcm91dGVyLmluaXQgPSBpbml0O1xuICByb3V0ZXIudHJhbnNpdGlvblRvID0gdHJhbnNpdGlvblRvO1xuICByb3V0ZXIuYmFja1RvID0gYmFja1RvO1xuICByb3V0ZXIuYWRkU3RhdGUgPSBhZGRTdGF0ZTtcbiAgcm91dGVyLmxpbmsgPSBsaW5rO1xuICByb3V0ZXIuY3VycmVudCA9IGdldEN1cnJlbnQ7XG4gIHJvdXRlci5wcmV2aW91cyA9IGdldFByZXZpb3VzO1xuICByb3V0ZXIuZmluZFN0YXRlID0gZmluZFN0YXRlO1xuICByb3V0ZXIuaXNGaXJzdFRyYW5zaXRpb24gPSBpc0ZpcnN0VHJhbnNpdGlvbjtcbiAgcm91dGVyLnBhcmFtc0RpZmYgPSBnZXRQYXJhbXNEaWZmO1xuICByb3V0ZXIub3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgcm91dGVyLnRyYW5zaXRpb24gPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgLy8gVXNlZCBmb3IgdGVzdGluZyBwdXJwb3NlcyBvbmx5XG4gIHJvdXRlci51cmxQYXRoUXVlcnkgPSB1cmxQYXRoUXVlcnk7XG4gIHJvdXRlci50ZXJtaW5hdGUgPSB0ZXJtaW5hdGU7XG5cbiAgdXRpbC5tZXJnZU9iamVjdHMoYXBpLCByb3V0ZXIpO1xuXG4gIHJldHVybiByb3V0ZXI7XG59XG5cbi8vIExvZ2dpbmdcblxudmFyIGxvZ2dlciA9IHtcbiAgbG9nOiB1dGlsLm5vb3AsXG4gIGVycm9yOiB1dGlsLm5vb3AsXG4gIGVuYWJsZWQ6IGZhbHNlXG59O1xuXG5Sb3V0ZXIuZW5hYmxlTG9ncyA9IGZ1bmN0aW9uICgpIHtcbiAgbG9nZ2VyLmVuYWJsZWQgPSB0cnVlO1xuXG4gIGxvZ2dlci5sb2cgPSBmdW5jdGlvbiAoKSB7XG4gICAgZm9yICh2YXIgX2xlbiA9IGFyZ3VtZW50cy5sZW5ndGgsIGFyZ3MgPSBBcnJheShfbGVuKSwgX2tleSA9IDA7IF9rZXkgPCBfbGVuOyBfa2V5KyspIHtcbiAgICAgIGFyZ3NbX2tleV0gPSBhcmd1bWVudHNbX2tleV07XG4gICAgfVxuXG4gICAgdmFyIG1lc3NhZ2UgPSB1dGlsLm1ha2VNZXNzYWdlLmFwcGx5KG51bGwsIGFyZ3MpO1xuICAgIGNvbnNvbGUubG9nKG1lc3NhZ2UpO1xuICB9O1xuXG4gIGxvZ2dlci5lcnJvciA9IGZ1bmN0aW9uICgpIHtcbiAgICBmb3IgKHZhciBfbGVuMiA9IGFyZ3VtZW50cy5sZW5ndGgsIGFyZ3MgPSBBcnJheShfbGVuMiksIF9rZXkyID0gMDsgX2tleTIgPCBfbGVuMjsgX2tleTIrKykge1xuICAgICAgYXJnc1tfa2V5Ml0gPSBhcmd1bWVudHNbX2tleTJdO1xuICAgIH1cblxuICAgIHZhciBtZXNzYWdlID0gdXRpbC5tYWtlTWVzc2FnZS5hcHBseShudWxsLCBhcmdzKTtcbiAgICBjb25zb2xlLmVycm9yKG1lc3NhZ2UpO1xuICB9O1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBSb3V0ZXI7IiwiXG4ndXNlIHN0cmljdCc7XG5cbnZhciB1dGlsID0gcmVxdWlyZSgnLi91dGlsJyk7XG5cbnZhciBQQVJBTVMgPSAvOlteXFxcXD9cXC9dKi9nO1xuXG4vKlxuKiBDcmVhdGVzIGEgbmV3IFN0YXRlIGluc3RhbmNlIGZyb20gYSB7dXJpLCBlbnRlciwgZXhpdCwgdXBkYXRlLCBkYXRhLCBjaGlsZHJlbn0gb2JqZWN0LlxuKiBUaGlzIGlzIHRoZSBpbnRlcm5hbCByZXByZXNlbnRhdGlvbiBvZiBhIHN0YXRlIHVzZWQgYnkgdGhlIHJvdXRlci5cbiovXG5mdW5jdGlvbiBTdGF0ZShvcHRpb25zKSB7XG4gIHZhciBzdGF0ZSA9IHsgb3B0aW9uczogb3B0aW9ucyB9LFxuICAgICAgc3RhdGVzID0gb3B0aW9ucy5jaGlsZHJlbjtcblxuICBzdGF0ZS5wYXRoID0gcGF0aEZyb21VUkkob3B0aW9ucy51cmkpO1xuICBzdGF0ZS5wYXJhbXMgPSBwYXJhbXNGcm9tVVJJKG9wdGlvbnMudXJpKTtcbiAgc3RhdGUucXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtc0Zyb21VUkkob3B0aW9ucy51cmkpO1xuICBzdGF0ZS5zdGF0ZXMgPSBzdGF0ZXM7XG5cbiAgc3RhdGUuZW50ZXIgPSBvcHRpb25zLmVudGVyIHx8IHV0aWwubm9vcDtcbiAgc3RhdGUudXBkYXRlID0gb3B0aW9ucy51cGRhdGU7XG4gIHN0YXRlLmV4aXQgPSBvcHRpb25zLmV4aXQgfHwgdXRpbC5ub29wO1xuXG4gIHN0YXRlLm93bkRhdGEgPSBvcHRpb25zLmRhdGEgfHwge307XG5cbiAgLypcbiAgKiBJbml0aWFsaXplIGFuZCBmcmVlemUgdGhpcyBzdGF0ZS5cbiAgKi9cbiAgZnVuY3Rpb24gaW5pdChyb3V0ZXIsIG5hbWUsIHBhcmVudCkge1xuICAgIHN0YXRlLnJvdXRlciA9IHJvdXRlcjtcbiAgICBzdGF0ZS5uYW1lID0gbmFtZTtcbiAgICBzdGF0ZS5pc0RlZmF1bHQgPSBuYW1lID09ICdfZGVmYXVsdF8nO1xuICAgIHN0YXRlLnBhcmVudCA9IHBhcmVudDtcbiAgICBzdGF0ZS5wYXJlbnRzID0gZ2V0UGFyZW50cygpO1xuICAgIHN0YXRlLnJvb3QgPSBzdGF0ZS5wYXJlbnQgPyBzdGF0ZS5wYXJlbnRzW3N0YXRlLnBhcmVudHMubGVuZ3RoIC0gMV0gOiBzdGF0ZTtcbiAgICBzdGF0ZS5jaGlsZHJlbiA9IHV0aWwub2JqZWN0VG9BcnJheShzdGF0ZXMpO1xuICAgIHN0YXRlLmZ1bGxOYW1lID0gZ2V0RnVsbE5hbWUoKTtcbiAgICBzdGF0ZS5hc1B1YmxpYyA9IG1ha2VQdWJsaWNBUEkoKTtcblxuICAgIGVhY2hDaGlsZFN0YXRlKGZ1bmN0aW9uIChuYW1lLCBjaGlsZFN0YXRlKSB7XG4gICAgICBjaGlsZFN0YXRlLmluaXQocm91dGVyLCBuYW1lLCBzdGF0ZSk7XG4gICAgfSk7XG4gIH1cblxuICAvKlxuICAqIFRoZSBmdWxsIHBhdGgsIGNvbXBvc2VkIG9mIGFsbCB0aGUgaW5kaXZpZHVhbCBwYXRocyBvZiB0aGlzIHN0YXRlIGFuZCBpdHMgcGFyZW50cy5cbiAgKi9cbiAgZnVuY3Rpb24gZnVsbFBhdGgoKSB7XG4gICAgdmFyIHJlc3VsdCA9IHN0YXRlLnBhdGgsXG4gICAgICAgIHN0YXRlUGFyZW50ID0gc3RhdGUucGFyZW50O1xuXG4gICAgd2hpbGUgKHN0YXRlUGFyZW50KSB7XG4gICAgICBpZiAoc3RhdGVQYXJlbnQucGF0aCkgcmVzdWx0ID0gc3RhdGVQYXJlbnQucGF0aCArICcvJyArIHJlc3VsdDtcbiAgICAgIHN0YXRlUGFyZW50ID0gc3RhdGVQYXJlbnQucGFyZW50O1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvKlxuICAqIFRoZSBsaXN0IG9mIGFsbCBwYXJlbnRzLCBzdGFydGluZyBmcm9tIHRoZSBjbG9zZXN0IG9uZXMuXG4gICovXG4gIGZ1bmN0aW9uIGdldFBhcmVudHMoKSB7XG4gICAgdmFyIHBhcmVudHMgPSBbXSxcbiAgICAgICAgcGFyZW50ID0gc3RhdGUucGFyZW50O1xuXG4gICAgd2hpbGUgKHBhcmVudCkge1xuICAgICAgcGFyZW50cy5wdXNoKHBhcmVudCk7XG4gICAgICBwYXJlbnQgPSBwYXJlbnQucGFyZW50O1xuICAgIH1cblxuICAgIHJldHVybiBwYXJlbnRzO1xuICB9XG5cbiAgLypcbiAgKiBUaGUgZnVsbHkgcXVhbGlmaWVkIG5hbWUgb2YgdGhpcyBzdGF0ZS5cbiAgKiBlLmcgZ3JhbnBhcmVudE5hbWUucGFyZW50TmFtZS5uYW1lXG4gICovXG4gIGZ1bmN0aW9uIGdldEZ1bGxOYW1lKCkge1xuICAgIHZhciByZXN1bHQgPSBzdGF0ZS5wYXJlbnRzLnJlZHVjZVJpZ2h0KGZ1bmN0aW9uIChhY2MsIHBhcmVudCkge1xuICAgICAgcmV0dXJuIGFjYyArIHBhcmVudC5uYW1lICsgJy4nO1xuICAgIH0sICcnKSArIHN0YXRlLm5hbWU7XG5cbiAgICByZXR1cm4gc3RhdGUuaXNEZWZhdWx0ID8gcmVzdWx0LnJlcGxhY2UoJy5fZGVmYXVsdF8nLCAnJykgOiByZXN1bHQ7XG4gIH1cblxuICBmdW5jdGlvbiBhbGxRdWVyeVBhcmFtcygpIHtcbiAgICByZXR1cm4gc3RhdGUucGFyZW50cy5yZWR1Y2UoZnVuY3Rpb24gKGFjYywgcGFyZW50KSB7XG4gICAgICByZXR1cm4gdXRpbC5tZXJnZU9iamVjdHMoYWNjLCBwYXJlbnQucXVlcnlQYXJhbXMpO1xuICAgIH0sIHV0aWwuY29weU9iamVjdChzdGF0ZS5xdWVyeVBhcmFtcykpO1xuICB9XG5cbiAgLypcbiAgKiBHZXQgb3IgU2V0IHNvbWUgYXJiaXRyYXJ5IGRhdGEgYnkga2V5IG9uIHRoaXMgc3RhdGUuXG4gICogY2hpbGQgc3RhdGVzIGhhdmUgYWNjZXNzIHRvIHRoZWlyIHBhcmVudHMnIGRhdGEuXG4gICpcbiAgKiBUaGlzIGNhbiBiZSB1c2VmdWwgd2hlbiB1c2luZyBleHRlcm5hbCBtb2RlbHMvc2VydmljZXNcbiAgKiBhcyBhIG1lYW4gdG8gY29tbXVuaWNhdGUgYmV0d2VlbiBzdGF0ZXMgaXMgbm90IGRlc2lyZWQuXG4gICovXG4gIGZ1bmN0aW9uIGRhdGEoa2V5LCB2YWx1ZSkge1xuICAgIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBzdGF0ZS5vd25EYXRhW2tleV0gPSB2YWx1ZTtcbiAgICAgIHJldHVybiBzdGF0ZTtcbiAgICB9XG5cbiAgICB2YXIgY3VycmVudFN0YXRlID0gc3RhdGU7XG5cbiAgICB3aGlsZSAoY3VycmVudFN0YXRlLm93bkRhdGFba2V5XSA9PT0gdW5kZWZpbmVkICYmIGN1cnJlbnRTdGF0ZS5wYXJlbnQpIGN1cnJlbnRTdGF0ZSA9IGN1cnJlbnRTdGF0ZS5wYXJlbnQ7XG5cbiAgICByZXR1cm4gY3VycmVudFN0YXRlLm93bkRhdGFba2V5XTtcbiAgfVxuXG4gIGZ1bmN0aW9uIG1ha2VQdWJsaWNBUEkoKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6IHN0YXRlLm5hbWUsXG4gICAgICBmdWxsTmFtZTogc3RhdGUuZnVsbE5hbWUsXG4gICAgICBwYXJlbnQ6IHN0YXRlLnBhcmVudCAmJiBzdGF0ZS5wYXJlbnQuYXNQdWJsaWMsXG4gICAgICBkYXRhOiBkYXRhXG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVhY2hDaGlsZFN0YXRlKGNhbGxiYWNrKSB7XG4gICAgZm9yICh2YXIgbmFtZSBpbiBzdGF0ZXMpIGNhbGxiYWNrKG5hbWUsIHN0YXRlc1tuYW1lXSk7XG4gIH1cblxuICAvKlxuICAqIFJldHVybnMgd2hldGhlciB0aGlzIHN0YXRlIG1hdGNoZXMgdGhlIHBhc3NlZCBwYXRoIEFycmF5LlxuICAqIEluIGNhc2Ugb2YgYSBtYXRjaCwgdGhlIGFjdHVhbCBwYXJhbSB2YWx1ZXMgYXJlIHJldHVybmVkLlxuICAqL1xuICBmdW5jdGlvbiBtYXRjaGVzKHBhdGhzKSB7XG4gICAgdmFyIHBhcmFtcyA9IHt9O1xuICAgIHZhciBub25SZXN0U3RhdGVQYXRocyA9IHN0YXRlLnBhdGhzLmZpbHRlcihmdW5jdGlvbiAocCkge1xuICAgICAgcmV0dXJuIHBbcC5sZW5ndGggLSAxXSAhPSAnKic7XG4gICAgfSk7XG5cbiAgICAvKiBUaGlzIHN0YXRlIGhhcyBtb3JlIHBhdGhzIHRoYW4gdGhlIHBhc3NlZCBwYXRocywgaXQgY2Fubm90IGJlIGEgbWF0Y2ggKi9cbiAgICBpZiAobm9uUmVzdFN0YXRlUGF0aHMubGVuZ3RoID4gcGF0aHMubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG5cbiAgICAvKiBDaGVja3MgaWYgdGhlIHBhdGhzIG1hdGNoIG9uZSBieSBvbmUgKi9cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHBhdGhzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB2YXIgcGF0aCA9IHBhdGhzW2ldO1xuICAgICAgdmFyIHRoYXRQYXRoID0gc3RhdGUucGF0aHNbaV07XG5cbiAgICAgIC8qIFRoaXMgc3RhdGUgaGFzIGxlc3MgcGF0aHMgdGhhbiB0aGUgcGFzc2VkIHBhdGhzLCBpdCBjYW5ub3QgYmUgYSBtYXRjaCAqL1xuICAgICAgaWYgKCF0aGF0UGF0aCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICB2YXIgaXNSZXN0ID0gdGhhdFBhdGhbdGhhdFBhdGgubGVuZ3RoIC0gMV0gPT0gJyonO1xuICAgICAgaWYgKGlzUmVzdCkge1xuICAgICAgICB2YXIgbmFtZSA9IHBhcmFtTmFtZSh0aGF0UGF0aCk7XG4gICAgICAgIHBhcmFtc1tuYW1lXSA9IHBhdGhzLnNsaWNlKGkpLmpvaW4oJy8nKTtcbiAgICAgICAgcmV0dXJuIHBhcmFtcztcbiAgICAgIH1cblxuICAgICAgdmFyIGlzRHluYW1pYyA9IHRoYXRQYXRoWzBdID09ICc6JztcbiAgICAgIGlmIChpc0R5bmFtaWMpIHtcbiAgICAgICAgdmFyIG5hbWUgPSBwYXJhbU5hbWUodGhhdFBhdGgpO1xuICAgICAgICBwYXJhbXNbbmFtZV0gPSBwYXRoO1xuICAgICAgfSBlbHNlIGlmICh0aGF0UGF0aCAhPSBwYXRoKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgcmV0dXJuIHBhcmFtcztcbiAgfVxuXG4gIC8qXG4gICogUmV0dXJucyBhIFVSSSBidWlsdCBmcm9tIHRoaXMgc3RhdGUgYW5kIHRoZSBwYXNzZWQgcGFyYW1zLlxuICAqL1xuICBmdW5jdGlvbiBpbnRlcnBvbGF0ZShwYXJhbXMpIHtcbiAgICB2YXIgcGF0aCA9IHN0YXRlLmZ1bGxQYXRoKCkucmVwbGFjZShQQVJBTVMsIGZ1bmN0aW9uIChwKSB7XG4gICAgICByZXR1cm4gcGFyYW1zW3BhcmFtTmFtZShwKV0gfHwgJyc7XG4gICAgfSk7XG5cbiAgICB2YXIgcXVlcnlQYXJhbXMgPSBhbGxRdWVyeVBhcmFtcygpO1xuICAgIHZhciBwYXNzZWRRdWVyeVBhcmFtcyA9IE9iamVjdC5rZXlzKHBhcmFtcykuZmlsdGVyKGZ1bmN0aW9uIChwKSB7XG4gICAgICByZXR1cm4gcXVlcnlQYXJhbXNbcF07XG4gICAgfSk7XG5cbiAgICB2YXIgcXVlcnkgPSBwYXNzZWRRdWVyeVBhcmFtcy5tYXAoZnVuY3Rpb24gKHApIHtcbiAgICAgIHJldHVybiBwICsgJz0nICsgcGFyYW1zW3BdO1xuICAgIH0pLmpvaW4oJyYnKTtcblxuICAgIHJldHVybiBwYXRoICsgKHF1ZXJ5Lmxlbmd0aCA/ICc/JyArIHF1ZXJ5IDogJycpO1xuICB9XG5cbiAgZnVuY3Rpb24gdG9TdHJpbmcoKSB7XG4gICAgcmV0dXJuIHN0YXRlLmZ1bGxOYW1lO1xuICB9XG5cbiAgc3RhdGUuaW5pdCA9IGluaXQ7XG4gIHN0YXRlLmZ1bGxQYXRoID0gZnVsbFBhdGg7XG4gIHN0YXRlLmFsbFF1ZXJ5UGFyYW1zID0gYWxsUXVlcnlQYXJhbXM7XG4gIHN0YXRlLm1hdGNoZXMgPSBtYXRjaGVzO1xuICBzdGF0ZS5pbnRlcnBvbGF0ZSA9IGludGVycG9sYXRlO1xuICBzdGF0ZS5kYXRhID0gZGF0YTtcbiAgc3RhdGUudG9TdHJpbmcgPSB0b1N0cmluZztcblxuICByZXR1cm4gc3RhdGU7XG59XG5cbmZ1bmN0aW9uIHBhcmFtTmFtZShwYXJhbSkge1xuICByZXR1cm4gcGFyYW1bcGFyYW0ubGVuZ3RoIC0gMV0gPT0gJyonID8gcGFyYW0uc3Vic3RyKDEpLnNsaWNlKDAsIC0xKSA6IHBhcmFtLnN1YnN0cigxKTtcbn1cblxuZnVuY3Rpb24gcGF0aEZyb21VUkkodXJpKSB7XG4gIHJldHVybiAodXJpIHx8ICcnKS5zcGxpdCgnPycpWzBdO1xufVxuXG5mdW5jdGlvbiBwYXJhbXNGcm9tVVJJKHVyaSkge1xuICB2YXIgbWF0Y2hlcyA9IFBBUkFNUy5leGVjKHVyaSk7XG4gIHJldHVybiBtYXRjaGVzID8gdXRpbC5hcnJheVRvT2JqZWN0KG1hdGNoZXMubWFwKHBhcmFtTmFtZSkpIDoge307XG59XG5cbmZ1bmN0aW9uIHF1ZXJ5UGFyYW1zRnJvbVVSSSh1cmkpIHtcbiAgdmFyIHF1ZXJ5ID0gKHVyaSB8fCAnJykuc3BsaXQoJz8nKVsxXTtcbiAgcmV0dXJuIHF1ZXJ5ID8gdXRpbC5hcnJheVRvT2JqZWN0KHF1ZXJ5LnNwbGl0KCcmJykpIDoge307XG59XG5cbm1vZHVsZS5leHBvcnRzID0gU3RhdGU7IiwiXG4ndXNlIHN0cmljdCc7XG5cbi8qXG4qIENyZWF0ZXMgYSBuZXcgU3RhdGVXaXRoUGFyYW1zIGluc3RhbmNlLlxuKlxuKiBTdGF0ZVdpdGhQYXJhbXMgaXMgdGhlIG1lcmdlIGJldHdlZW4gYSBTdGF0ZSBvYmplY3QgKGNyZWF0ZWQgYW5kIGFkZGVkIHRvIHRoZSByb3V0ZXIgYmVmb3JlIGluaXQpXG4qIGFuZCBwYXJhbXMgKGJvdGggcGF0aCBhbmQgcXVlcnkgcGFyYW1zLCBleHRyYWN0ZWQgZnJvbSB0aGUgVVJMIGFmdGVyIGluaXQpXG4qXG4qIFRoaXMgaXMgYW4gaW50ZXJuYWwgbW9kZWw7IFRoZSBwdWJsaWMgbW9kZWwgaXMgdGhlIGFzUHVibGljIHByb3BlcnR5LlxuKi9cbmZ1bmN0aW9uIFN0YXRlV2l0aFBhcmFtcyhzdGF0ZSwgcGFyYW1zLCBwYXRoUXVlcnkpIHtcbiAgcmV0dXJuIHtcbiAgICBzdGF0ZTogc3RhdGUsXG4gICAgcGFyYW1zOiBwYXJhbXMsXG4gICAgdG9TdHJpbmc6IHRvU3RyaW5nLFxuICAgIGFzUHVibGljOiBtYWtlUHVibGljQVBJKHN0YXRlLCBwYXJhbXMsIHBhdGhRdWVyeSlcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZVB1YmxpY0FQSShzdGF0ZSwgcGFyYW1zLCBwYXRoUXVlcnkpIHtcblxuICAvKlxuICAqIFJldHVybnMgd2hldGhlciB0aGlzIHN0YXRlIG9yIGFueSBvZiBpdHMgcGFyZW50cyBoYXMgdGhlIGdpdmVuIGZ1bGxOYW1lLlxuICAqL1xuICBmdW5jdGlvbiBpc0luKGZ1bGxTdGF0ZU5hbWUpIHtcbiAgICB2YXIgY3VycmVudCA9IHN0YXRlO1xuICAgIHdoaWxlIChjdXJyZW50KSB7XG4gICAgICBpZiAoY3VycmVudC5mdWxsTmFtZSA9PSBmdWxsU3RhdGVOYW1lKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudDtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICB1cmk6IHBhdGhRdWVyeSxcbiAgICBwYXJhbXM6IHBhcmFtcyxcbiAgICBuYW1lOiBzdGF0ZSA/IHN0YXRlLm5hbWUgOiAnJyxcbiAgICBmdWxsTmFtZTogc3RhdGUgPyBzdGF0ZS5mdWxsTmFtZSA6ICcnLFxuICAgIGRhdGE6IHN0YXRlID8gc3RhdGUuZGF0YSA6IG51bGwsXG4gICAgaXNJbjogaXNJblxuICB9O1xufVxuXG5mdW5jdGlvbiB0b1N0cmluZygpIHtcbiAgdmFyIG5hbWUgPSB0aGlzLnN0YXRlICYmIHRoaXMuc3RhdGUuZnVsbE5hbWU7XG4gIHJldHVybiBuYW1lICsgJzonICsgSlNPTi5zdHJpbmdpZnkodGhpcy5wYXJhbXMpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IFN0YXRlV2l0aFBhcmFtczsiLCJcbid1c2Ugc3RyaWN0JztcblxuLypcbiogQ3JlYXRlIGEgbmV3IFRyYW5zaXRpb24gaW5zdGFuY2UuXG4qL1xuZnVuY3Rpb24gVHJhbnNpdGlvbihmcm9tU3RhdGVXaXRoUGFyYW1zLCB0b1N0YXRlV2l0aFBhcmFtcywgcGFyYW1zRGlmZiwgYWNjLCByb3V0ZXIsIGxvZ2dlcikge1xuICB2YXIgcm9vdCwgZW50ZXJzLCBleGl0cztcblxuICB2YXIgZnJvbVN0YXRlID0gZnJvbVN0YXRlV2l0aFBhcmFtcyAmJiBmcm9tU3RhdGVXaXRoUGFyYW1zLnN0YXRlO1xuICB2YXIgdG9TdGF0ZSA9IHRvU3RhdGVXaXRoUGFyYW1zLnN0YXRlO1xuICB2YXIgcGFyYW1zID0gdG9TdGF0ZVdpdGhQYXJhbXMucGFyYW1zO1xuICB2YXIgaXNVcGRhdGUgPSBmcm9tU3RhdGUgPT0gdG9TdGF0ZTtcblxuICB2YXIgdHJhbnNpdGlvbiA9IHtcbiAgICBmcm9tOiBmcm9tU3RhdGUsXG4gICAgdG86IHRvU3RhdGUsXG4gICAgdG9QYXJhbXM6IHBhcmFtcyxcbiAgICBjYW5jZWw6IGNhbmNlbCxcbiAgICBjYW5jZWxsZWQ6IGZhbHNlLFxuICAgIGN1cnJlbnRTdGF0ZTogZnJvbVN0YXRlLFxuICAgIHJ1bjogcnVuXG4gIH07XG5cbiAgLy8gVGhlIGZpcnN0IHRyYW5zaXRpb24gaGFzIG5vIGZyb21TdGF0ZS5cbiAgaWYgKGZyb21TdGF0ZSkgcm9vdCA9IHRyYW5zaXRpb25Sb290KGZyb21TdGF0ZSwgdG9TdGF0ZSwgaXNVcGRhdGUsIHBhcmFtc0RpZmYpO1xuXG4gIHZhciBpbmNsdXNpdmUgPSAhcm9vdCB8fCBpc1VwZGF0ZTtcbiAgZXhpdHMgPSBmcm9tU3RhdGUgPyB0cmFuc2l0aW9uU3RhdGVzKGZyb21TdGF0ZSwgcm9vdCwgaW5jbHVzaXZlKSA6IFtdO1xuICBlbnRlcnMgPSB0cmFuc2l0aW9uU3RhdGVzKHRvU3RhdGUsIHJvb3QsIGluY2x1c2l2ZSkucmV2ZXJzZSgpO1xuXG4gIGZ1bmN0aW9uIHJ1bigpIHtcbiAgICBzdGFydFRyYW5zaXRpb24oZW50ZXJzLCBleGl0cywgcGFyYW1zLCB0cmFuc2l0aW9uLCBpc1VwZGF0ZSwgYWNjLCByb3V0ZXIsIGxvZ2dlcik7XG4gIH1cblxuICBmdW5jdGlvbiBjYW5jZWwoKSB7XG4gICAgdHJhbnNpdGlvbi5jYW5jZWxsZWQgPSB0cnVlO1xuICB9XG5cbiAgcmV0dXJuIHRyYW5zaXRpb247XG59XG5cbmZ1bmN0aW9uIHN0YXJ0VHJhbnNpdGlvbihlbnRlcnMsIGV4aXRzLCBwYXJhbXMsIHRyYW5zaXRpb24sIGlzVXBkYXRlLCBhY2MsIHJvdXRlciwgbG9nZ2VyKSB7XG4gIGFjYyA9IGFjYyB8fCB7fTtcblxuICB0cmFuc2l0aW9uLmV4aXRpbmcgPSB0cnVlO1xuICBleGl0cy5mb3JFYWNoKGZ1bmN0aW9uIChzdGF0ZSkge1xuICAgIGlmIChpc1VwZGF0ZSAmJiBzdGF0ZS51cGRhdGUpIHJldHVybjtcbiAgICBydW5TdGVwKHN0YXRlLCAnZXhpdCcsIHBhcmFtcywgdHJhbnNpdGlvbiwgYWNjLCByb3V0ZXIsIGxvZ2dlcik7XG4gIH0pO1xuICB0cmFuc2l0aW9uLmV4aXRpbmcgPSBmYWxzZTtcblxuICBlbnRlcnMuZm9yRWFjaChmdW5jdGlvbiAoc3RhdGUpIHtcbiAgICB2YXIgZm4gPSBpc1VwZGF0ZSAmJiBzdGF0ZS51cGRhdGUgPyAndXBkYXRlJyA6ICdlbnRlcic7XG4gICAgcnVuU3RlcChzdGF0ZSwgZm4sIHBhcmFtcywgdHJhbnNpdGlvbiwgYWNjLCByb3V0ZXIsIGxvZ2dlcik7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBydW5TdGVwKHN0YXRlLCBzdGVwRm4sIHBhcmFtcywgdHJhbnNpdGlvbiwgYWNjLCByb3V0ZXIsIGxvZ2dlcikge1xuICBpZiAodHJhbnNpdGlvbi5jYW5jZWxsZWQpIHJldHVybjtcblxuICBpZiAobG9nZ2VyLmVuYWJsZWQpIHtcbiAgICB2YXIgY2FwaXRhbGl6ZWRTdGVwID0gc3RlcEZuWzBdLnRvVXBwZXJDYXNlKCkgKyBzdGVwRm4uc2xpY2UoMSk7XG4gICAgbG9nZ2VyLmxvZyhjYXBpdGFsaXplZFN0ZXAgKyAnICcgKyBzdGF0ZS5mdWxsTmFtZSk7XG4gIH1cblxuICB2YXIgcmVzdWx0ID0gc3RhdGVbc3RlcEZuXShwYXJhbXMsIGFjYywgcm91dGVyKTtcblxuICBpZiAodHJhbnNpdGlvbi5jYW5jZWxsZWQpIHJldHVybjtcblxuICB0cmFuc2l0aW9uLmN1cnJlbnRTdGF0ZSA9IHN0ZXBGbiA9PSAnZXhpdCcgPyBzdGF0ZS5wYXJlbnQgOiBzdGF0ZTtcblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKlxuKiBUaGUgdG9wLW1vc3QgY3VycmVudCBzdGF0ZSdzIHBhcmVudCB0aGF0IG11c3QgYmUgZXhpdGVkLlxuKi9cbmZ1bmN0aW9uIHRyYW5zaXRpb25Sb290KGZyb21TdGF0ZSwgdG9TdGF0ZSwgaXNVcGRhdGUsIHBhcmFtc0RpZmYpIHtcbiAgdmFyIHJvb3QsIHBhcmVudCwgcGFyYW07XG5cbiAgLy8gRm9yIGEgcGFyYW0tb25seSBjaGFuZ2UsIHRoZSByb290IGlzIHRoZSB0b3AtbW9zdCBzdGF0ZSBvd25pbmcgdGhlIHBhcmFtKHMpLFxuICBpZiAoaXNVcGRhdGUpIHtcbiAgICBbZnJvbVN0YXRlXS5jb25jYXQoZnJvbVN0YXRlLnBhcmVudHMpLnJldmVyc2UoKS5mb3JFYWNoKGZ1bmN0aW9uIChwYXJlbnQpIHtcbiAgICAgIGlmIChyb290KSByZXR1cm47XG5cbiAgICAgIGZvciAocGFyYW0gaW4gcGFyYW1zRGlmZi5hbGwpIHtcbiAgICAgICAgaWYgKHBhcmVudC5wYXJhbXNbcGFyYW1dIHx8IHBhcmVudC5xdWVyeVBhcmFtc1twYXJhbV0pIHtcbiAgICAgICAgICByb290ID0gcGFyZW50O1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgLy8gRWxzZSwgdGhlIHJvb3QgaXMgdGhlIGNsb3Nlc3QgY29tbW9uIHBhcmVudCBvZiB0aGUgdHdvIHN0YXRlcy5cbiAgZWxzZSB7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZyb21TdGF0ZS5wYXJlbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHBhcmVudCA9IGZyb21TdGF0ZS5wYXJlbnRzW2ldO1xuICAgICAgICBpZiAodG9TdGF0ZS5wYXJlbnRzLmluZGV4T2YocGFyZW50KSA+IC0xKSB7XG4gICAgICAgICAgcm9vdCA9IHBhcmVudDtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICByZXR1cm4gcm9vdDtcbn1cblxuZnVuY3Rpb24gdHJhbnNpdGlvblN0YXRlcyhzdGF0ZSwgcm9vdCwgaW5jbHVzaXZlKSB7XG4gIHJvb3QgPSByb290IHx8IHN0YXRlLnJvb3Q7XG5cbiAgdmFyIHAgPSBzdGF0ZS5wYXJlbnRzLFxuICAgICAgZW5kID0gTWF0aC5taW4ocC5sZW5ndGgsIHAuaW5kZXhPZihyb290KSArIChpbmNsdXNpdmUgPyAxIDogMCkpO1xuXG4gIHJldHVybiBbc3RhdGVdLmNvbmNhdChwLnNsaWNlKDAsIGVuZCkpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IFRyYW5zaXRpb247IiwiXG4ndXNlIHN0cmljdCc7XG5cbnZhciByb3V0ZXI7XG5cbmZ1bmN0aW9uIG9uTW91c2VEb3duKGV2dCkge1xuICB2YXIgaHJlZiA9IGhyZWZGb3JFdmVudChldnQpO1xuXG4gIGlmIChocmVmICE9PSB1bmRlZmluZWQpIHJvdXRlci50cmFuc2l0aW9uVG8oaHJlZik7XG59XG5cbmZ1bmN0aW9uIG9uTW91c2VDbGljayhldnQpIHtcbiAgdmFyIGhyZWYgPSBocmVmRm9yRXZlbnQoZXZ0KTtcblxuICBpZiAoaHJlZiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG5cbiAgICByb3V0ZXIudHJhbnNpdGlvblRvKGhyZWYpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGhyZWZGb3JFdmVudChldnQpIHtcbiAgaWYgKGV2dC5kZWZhdWx0UHJldmVudGVkIHx8IGV2dC5tZXRhS2V5IHx8IGV2dC5jdHJsS2V5IHx8ICFpc0xlZnRCdXR0b24oZXZ0KSkgcmV0dXJuO1xuXG4gIHZhciB0YXJnZXQgPSBldnQudGFyZ2V0O1xuICB2YXIgYW5jaG9yID0gYW5jaG9yVGFyZ2V0KHRhcmdldCk7XG4gIGlmICghYW5jaG9yKSByZXR1cm47XG5cbiAgdmFyIGRhdGFOYXYgPSBhbmNob3IuZ2V0QXR0cmlidXRlKCdkYXRhLW5hdicpO1xuXG4gIGlmIChkYXRhTmF2ID09ICdpZ25vcmUnKSByZXR1cm47XG4gIGlmIChldnQudHlwZSA9PSAnbW91c2Vkb3duJyAmJiBkYXRhTmF2ICE9ICdtb3VzZWRvd24nKSByZXR1cm47XG5cbiAgdmFyIGhyZWYgPSBhbmNob3IuZ2V0QXR0cmlidXRlKCdocmVmJyk7XG5cbiAgaWYgKCFocmVmKSByZXR1cm47XG4gIGlmIChocmVmLmNoYXJBdCgwKSA9PSAnIycpIHtcbiAgICBpZiAocm91dGVyLm9wdGlvbnMudXJsU3luYyAhPSAnaGFzaCcpIHJldHVybjtcbiAgICBocmVmID0gaHJlZi5zbGljZSgxKTtcbiAgfVxuICBpZiAoYW5jaG9yLmdldEF0dHJpYnV0ZSgndGFyZ2V0JykgPT0gJ19ibGFuaycpIHJldHVybjtcbiAgaWYgKCFpc0xvY2FsTGluayhhbmNob3IpKSByZXR1cm47XG5cbiAgLy8gQXQgdGhpcyBwb2ludCwgd2UgaGF2ZSBhIHZhbGlkIGhyZWYgdG8gZm9sbG93LlxuICAvLyBEaWQgdGhlIG5hdmlnYXRpb24gYWxyZWFkeSBvY2N1ciBvbiBtb3VzZWRvd24gdGhvdWdoP1xuICBpZiAoZXZ0LnR5cGUgPT0gJ2NsaWNrJyAmJiBkYXRhTmF2ID09ICdtb3VzZWRvd24nKSB7XG4gICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgcmV0dXJuIGhyZWY7XG59XG5cbmZ1bmN0aW9uIGlzTGVmdEJ1dHRvbihldnQpIHtcbiAgcmV0dXJuIGV2dC53aGljaCA9PSAxO1xufVxuXG5mdW5jdGlvbiBhbmNob3JUYXJnZXQodGFyZ2V0KSB7XG4gIHdoaWxlICh0YXJnZXQpIHtcbiAgICBpZiAodGFyZ2V0Lm5vZGVOYW1lID09ICdBJykgcmV0dXJuIHRhcmdldDtcbiAgICB0YXJnZXQgPSB0YXJnZXQucGFyZW50Tm9kZTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc0xvY2FsTGluayhhbmNob3IpIHtcbiAgdmFyIGhvc3RuYW1lID0gYW5jaG9yLmhvc3RuYW1lO1xuICB2YXIgcG9ydCA9IGFuY2hvci5wb3J0O1xuXG4gIC8vIElFMTAgY2FuIGxvc2UgdGhlIGhvc3RuYW1lL3BvcnQgcHJvcGVydHkgd2hlbiBzZXR0aW5nIGEgcmVsYXRpdmUgaHJlZiBmcm9tIEpTXG4gIGlmICghaG9zdG5hbWUpIHtcbiAgICB2YXIgdGVtcEFuY2hvciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpO1xuICAgIHRlbXBBbmNob3IuaHJlZiA9IGFuY2hvci5ocmVmO1xuICAgIGhvc3RuYW1lID0gdGVtcEFuY2hvci5ob3N0bmFtZTtcbiAgICBwb3J0ID0gdGVtcEFuY2hvci5wb3J0O1xuICB9XG5cbiAgdmFyIHNhbWVIb3N0bmFtZSA9IGhvc3RuYW1lID09IGxvY2F0aW9uLmhvc3RuYW1lO1xuICB2YXIgc2FtZVBvcnQgPSAocG9ydCB8fCAnODAnKSA9PSAobG9jYXRpb24ucG9ydCB8fCAnODAnKTtcblxuICByZXR1cm4gc2FtZUhvc3RuYW1lICYmIHNhbWVQb3J0O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGludGVyY2VwdEFuY2hvcnMoZm9yUm91dGVyKSB7XG4gIHJvdXRlciA9IGZvclJvdXRlcjtcblxuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWRvd24nLCBvbk1vdXNlRG93bik7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgb25Nb3VzZUNsaWNrKTtcbn07IiwiXG4vKiBSZXByZXNlbnRzIHRoZSBwdWJsaWMgQVBJIG9mIHRoZSBsYXN0IGluc3RhbmNpYXRlZCByb3V0ZXI7IFVzZWZ1bCB0byBicmVhayBjaXJjdWxhciBkZXBlbmRlbmNpZXMgYmV0d2VlbiByb3V0ZXIgYW5kIGl0cyBzdGF0ZXMgKi9cblwidXNlIHN0cmljdFwiO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHt9OyIsIid1c2Ugc3RyaWN0JztcblxudmFyIGFwaSA9IHJlcXVpcmUoJy4vYXBpJyk7XG5cbi8qIFdyYXBzIGEgdGhlbm5hYmxlL3Byb21pc2UgYW5kIG9ubHkgcmVzb2x2ZSBpdCBpZiB0aGUgcm91dGVyIGRpZG4ndCB0cmFuc2l0aW9uIHRvIGFub3RoZXIgc3RhdGUgaW4gdGhlIG1lYW50aW1lICovXG5mdW5jdGlvbiBhc3luYyh3cmFwcGVkKSB7XG4gIHZhciBQcm9taXNlSW1wbCA9IGFzeW5jLlByb21pc2UgfHwgUHJvbWlzZTtcbiAgdmFyIGZpcmUgPSB0cnVlO1xuXG4gIGFwaS50cmFuc2l0aW9uLm9uY2UoJ3N0YXJ0ZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgZmlyZSA9IGZhbHNlO1xuICB9KTtcblxuICB2YXIgcHJvbWlzZSA9IG5ldyBQcm9taXNlSW1wbChmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgd3JhcHBlZC50aGVuKGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgaWYgKGZpcmUpIHJlc29sdmUodmFsdWUpO1xuICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgIGlmIChmaXJlKSByZWplY3QoZXJyKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgcmV0dXJuIHByb21pc2U7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGFzeW5jOyIsIlxuJ3VzZSBzdHJpY3QnO1xuXG52YXIgdXRpbCA9IHJlcXVpcmUoJy4vdXRpbCcpO1xuXG52YXIgQWJ5c3NhID0ge1xuICBSb3V0ZXI6IHJlcXVpcmUoJy4vUm91dGVyJyksXG4gIGFwaTogcmVxdWlyZSgnLi9hcGknKSxcbiAgYXN5bmM6IHJlcXVpcmUoJy4vYXN5bmMnKSxcbiAgU3RhdGU6IHV0aWwuc3RhdGVTaG9ydGhhbmQsXG5cbiAgX3V0aWw6IHV0aWxcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gQWJ5c3NhOyIsIlxuJ3VzZSBzdHJpY3QnO1xuXG52YXIgdXRpbCA9IHt9O1xuXG51dGlsLm5vb3AgPSBmdW5jdGlvbiAoKSB7fTtcblxudXRpbC5hcnJheVRvT2JqZWN0ID0gZnVuY3Rpb24gKGFycmF5KSB7XG4gIHJldHVybiBhcnJheS5yZWR1Y2UoZnVuY3Rpb24gKG9iaiwgaXRlbSkge1xuICAgIG9ialtpdGVtXSA9IDE7XG4gICAgcmV0dXJuIG9iajtcbiAgfSwge30pO1xufTtcblxudXRpbC5vYmplY3RUb0FycmF5ID0gZnVuY3Rpb24gKG9iaikge1xuICB2YXIgYXJyYXkgPSBbXTtcbiAgZm9yICh2YXIga2V5IGluIG9iaikgYXJyYXkucHVzaChvYmpba2V5XSk7XG4gIHJldHVybiBhcnJheTtcbn07XG5cbnV0aWwuY29weU9iamVjdCA9IGZ1bmN0aW9uIChvYmopIHtcbiAgdmFyIGNvcHkgPSB7fTtcbiAgZm9yICh2YXIga2V5IGluIG9iaikgY29weVtrZXldID0gb2JqW2tleV07XG4gIHJldHVybiBjb3B5O1xufTtcblxudXRpbC5tZXJnZU9iamVjdHMgPSBmdW5jdGlvbiAodG8sIGZyb20pIHtcbiAgZm9yICh2YXIga2V5IGluIGZyb20pIHRvW2tleV0gPSBmcm9tW2tleV07XG4gIHJldHVybiB0bztcbn07XG5cbnV0aWwubWFwVmFsdWVzID0gZnVuY3Rpb24gKG9iaiwgZm4pIHtcbiAgdmFyIHJlc3VsdCA9IHt9O1xuICBmb3IgKHZhciBrZXkgaW4gb2JqKSB7XG4gICAgcmVzdWx0W2tleV0gPSBmbihvYmpba2V5XSk7XG4gIH1cbiAgcmV0dXJuIHJlc3VsdDtcbn07XG5cbi8qXG4qIFJldHVybiB0aGUgc2V0IG9mIGFsbCB0aGUga2V5cyB0aGF0IGNoYW5nZWQgKGVpdGhlciBhZGRlZCwgcmVtb3ZlZCBvciBtb2RpZmllZCkuXG4qL1xudXRpbC5vYmplY3REaWZmID0gZnVuY3Rpb24gKG9iajEsIG9iajIpIHtcbiAgdmFyIHVwZGF0ZSA9IHt9LFxuICAgICAgZW50ZXIgPSB7fSxcbiAgICAgIGV4aXQgPSB7fSxcbiAgICAgIGFsbCA9IHt9LFxuICAgICAgbmFtZSxcbiAgICAgIG9iajEgPSBvYmoxIHx8IHt9O1xuXG4gIGZvciAobmFtZSBpbiBvYmoxKSB7XG4gICAgaWYgKCEobmFtZSBpbiBvYmoyKSkgZXhpdFtuYW1lXSA9IGFsbFtuYW1lXSA9IHRydWU7ZWxzZSBpZiAob2JqMVtuYW1lXSAhPSBvYmoyW25hbWVdKSB1cGRhdGVbbmFtZV0gPSBhbGxbbmFtZV0gPSB0cnVlO1xuICB9XG5cbiAgZm9yIChuYW1lIGluIG9iajIpIHtcbiAgICBpZiAoIShuYW1lIGluIG9iajEpKSBlbnRlcltuYW1lXSA9IGFsbFtuYW1lXSA9IHRydWU7XG4gIH1cblxuICByZXR1cm4geyBhbGw6IGFsbCwgdXBkYXRlOiB1cGRhdGUsIGVudGVyOiBlbnRlciwgZXhpdDogZXhpdCB9O1xufTtcblxudXRpbC5tYWtlTWVzc2FnZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG1lc3NhZ2UgPSBhcmd1bWVudHNbMF0sXG4gICAgICB0b2tlbnMgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuXG4gIGZvciAodmFyIGkgPSAwLCBsID0gdG9rZW5zLmxlbmd0aDsgaSA8IGw7IGkrKykgbWVzc2FnZSA9IG1lc3NhZ2UucmVwbGFjZSgneycgKyBpICsgJ30nLCB0b2tlbnNbaV0pO1xuXG4gIHJldHVybiBtZXNzYWdlO1xufTtcblxudXRpbC5wYXJzZVBhdGhzID0gZnVuY3Rpb24gKHBhdGgpIHtcbiAgcmV0dXJuIHBhdGguc3BsaXQoJy8nKS5maWx0ZXIoZnVuY3Rpb24gKHN0cikge1xuICAgIHJldHVybiBzdHIubGVuZ3RoO1xuICB9KS5tYXAoZnVuY3Rpb24gKHN0cikge1xuICAgIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQoc3RyKTtcbiAgfSk7XG59O1xuXG51dGlsLnBhcnNlUXVlcnlQYXJhbXMgPSBmdW5jdGlvbiAocXVlcnkpIHtcbiAgcmV0dXJuIHF1ZXJ5ID8gcXVlcnkuc3BsaXQoJyYnKS5yZWR1Y2UoZnVuY3Rpb24gKHJlcywgcGFyYW1WYWx1ZSkge1xuICAgIHZhciBwdiA9IHBhcmFtVmFsdWUuc3BsaXQoJz0nKTtcbiAgICByZXNbcHZbMF1dID0gZGVjb2RlVVJJQ29tcG9uZW50KHB2WzFdKTtcbiAgICByZXR1cm4gcmVzO1xuICB9LCB7fSkgOiB7fTtcbn07XG5cbnZhciBMRUFESU5HX1NMQVNIRVMgPSAvXlxcLysvO1xudmFyIFRSQUlMSU5HX1NMQVNIRVMgPSAvXihbXj9dKj8pXFwvKyQvO1xudmFyIFRSQUlMSU5HX1NMQVNIRVNfQkVGT1JFX1FVRVJZID0gL1xcLytcXD8vO1xudXRpbC5ub3JtYWxpemVQYXRoUXVlcnkgPSBmdW5jdGlvbiAocGF0aFF1ZXJ5KSB7XG4gIHJldHVybiAnLycgKyBwYXRoUXVlcnkucmVwbGFjZShMRUFESU5HX1NMQVNIRVMsICcnKS5yZXBsYWNlKFRSQUlMSU5HX1NMQVNIRVMsICckMScpLnJlcGxhY2UoVFJBSUxJTkdfU0xBU0hFU19CRUZPUkVfUVVFUlksICc/Jyk7XG59O1xuXG51dGlsLnN0YXRlU2hvcnRoYW5kID0gZnVuY3Rpb24gKHVyaSwgb3B0aW9ucywgY2hpbGRyZW4pIHtcbiAgcmV0dXJuIHV0aWwubWVyZ2VPYmplY3RzKHsgdXJpOiB1cmksIGNoaWxkcmVuOiBjaGlsZHJlbiB8fCB7fSB9LCBvcHRpb25zKTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gdXRpbDsiLCIvLyBDb3B5cmlnaHQgSm95ZW50LCBJbmMuIGFuZCBvdGhlciBOb2RlIGNvbnRyaWJ1dG9ycy5cbi8vXG4vLyBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYVxuLy8gY29weSBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZVxuLy8gXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbCBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nXG4vLyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsXG4vLyBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbCBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0XG4vLyBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGVcbi8vIGZvbGxvd2luZyBjb25kaXRpb25zOlxuLy9cbi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkXG4vLyBpbiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbi8vXG4vLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTXG4vLyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GXG4vLyBNRVJDSEFOVEFCSUxJVFksIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuIElOXG4vLyBOTyBFVkVOVCBTSEFMTCBUSEUgQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSxcbi8vIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUlxuLy8gT1RIRVJXSVNFLCBBUklTSU5HIEZST00sIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRVxuLy8gVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRSBTT0ZUV0FSRS5cblxuZnVuY3Rpb24gRXZlbnRFbWl0dGVyKCkge1xuICB0aGlzLl9ldmVudHMgPSB0aGlzLl9ldmVudHMgfHwge307XG4gIHRoaXMuX21heExpc3RlbmVycyA9IHRoaXMuX21heExpc3RlbmVycyB8fCB1bmRlZmluZWQ7XG59XG5tb2R1bGUuZXhwb3J0cyA9IEV2ZW50RW1pdHRlcjtcblxuLy8gQmFja3dhcmRzLWNvbXBhdCB3aXRoIG5vZGUgMC4xMC54XG5FdmVudEVtaXR0ZXIuRXZlbnRFbWl0dGVyID0gRXZlbnRFbWl0dGVyO1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLl9ldmVudHMgPSB1bmRlZmluZWQ7XG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLl9tYXhMaXN0ZW5lcnMgPSB1bmRlZmluZWQ7XG5cbi8vIEJ5IGRlZmF1bHQgRXZlbnRFbWl0dGVycyB3aWxsIHByaW50IGEgd2FybmluZyBpZiBtb3JlIHRoYW4gMTAgbGlzdGVuZXJzIGFyZVxuLy8gYWRkZWQgdG8gaXQuIFRoaXMgaXMgYSB1c2VmdWwgZGVmYXVsdCB3aGljaCBoZWxwcyBmaW5kaW5nIG1lbW9yeSBsZWFrcy5cbkV2ZW50RW1pdHRlci5kZWZhdWx0TWF4TGlzdGVuZXJzID0gMTA7XG5cbi8vIE9idmlvdXNseSBub3QgYWxsIEVtaXR0ZXJzIHNob3VsZCBiZSBsaW1pdGVkIHRvIDEwLiBUaGlzIGZ1bmN0aW9uIGFsbG93c1xuLy8gdGhhdCB0byBiZSBpbmNyZWFzZWQuIFNldCB0byB6ZXJvIGZvciB1bmxpbWl0ZWQuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnNldE1heExpc3RlbmVycyA9IGZ1bmN0aW9uKG4pIHtcbiAgaWYgKCFpc051bWJlcihuKSB8fCBuIDwgMCB8fCBpc05hTihuKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ24gbXVzdCBiZSBhIHBvc2l0aXZlIG51bWJlcicpO1xuICB0aGlzLl9tYXhMaXN0ZW5lcnMgPSBuO1xuICByZXR1cm4gdGhpcztcbn07XG5cbkV2ZW50RW1pdHRlci5wcm90b3R5cGUuZW1pdCA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgdmFyIGVyLCBoYW5kbGVyLCBsZW4sIGFyZ3MsIGksIGxpc3RlbmVycztcblxuICBpZiAoIXRoaXMuX2V2ZW50cylcbiAgICB0aGlzLl9ldmVudHMgPSB7fTtcblxuICAvLyBJZiB0aGVyZSBpcyBubyAnZXJyb3InIGV2ZW50IGxpc3RlbmVyIHRoZW4gdGhyb3cuXG4gIGlmICh0eXBlID09PSAnZXJyb3InKSB7XG4gICAgaWYgKCF0aGlzLl9ldmVudHMuZXJyb3IgfHxcbiAgICAgICAgKGlzT2JqZWN0KHRoaXMuX2V2ZW50cy5lcnJvcikgJiYgIXRoaXMuX2V2ZW50cy5lcnJvci5sZW5ndGgpKSB7XG4gICAgICBlciA9IGFyZ3VtZW50c1sxXTtcbiAgICAgIGlmIChlciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICAgIHRocm93IGVyOyAvLyBVbmhhbmRsZWQgJ2Vycm9yJyBldmVudFxuICAgICAgfVxuICAgICAgdGhyb3cgVHlwZUVycm9yKCdVbmNhdWdodCwgdW5zcGVjaWZpZWQgXCJlcnJvclwiIGV2ZW50LicpO1xuICAgIH1cbiAgfVxuXG4gIGhhbmRsZXIgPSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgaWYgKGlzVW5kZWZpbmVkKGhhbmRsZXIpKVxuICAgIHJldHVybiBmYWxzZTtcblxuICBpZiAoaXNGdW5jdGlvbihoYW5kbGVyKSkge1xuICAgIHN3aXRjaCAoYXJndW1lbnRzLmxlbmd0aCkge1xuICAgICAgLy8gZmFzdCBjYXNlc1xuICAgICAgY2FzZSAxOlxuICAgICAgICBoYW5kbGVyLmNhbGwodGhpcyk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAyOlxuICAgICAgICBoYW5kbGVyLmNhbGwodGhpcywgYXJndW1lbnRzWzFdKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDM6XG4gICAgICAgIGhhbmRsZXIuY2FsbCh0aGlzLCBhcmd1bWVudHNbMV0sIGFyZ3VtZW50c1syXSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgLy8gc2xvd2VyXG4gICAgICBkZWZhdWx0OlxuICAgICAgICBsZW4gPSBhcmd1bWVudHMubGVuZ3RoO1xuICAgICAgICBhcmdzID0gbmV3IEFycmF5KGxlbiAtIDEpO1xuICAgICAgICBmb3IgKGkgPSAxOyBpIDwgbGVuOyBpKyspXG4gICAgICAgICAgYXJnc1tpIC0gMV0gPSBhcmd1bWVudHNbaV07XG4gICAgICAgIGhhbmRsZXIuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICB9IGVsc2UgaWYgKGlzT2JqZWN0KGhhbmRsZXIpKSB7XG4gICAgbGVuID0gYXJndW1lbnRzLmxlbmd0aDtcbiAgICBhcmdzID0gbmV3IEFycmF5KGxlbiAtIDEpO1xuICAgIGZvciAoaSA9IDE7IGkgPCBsZW47IGkrKylcbiAgICAgIGFyZ3NbaSAtIDFdID0gYXJndW1lbnRzW2ldO1xuXG4gICAgbGlzdGVuZXJzID0gaGFuZGxlci5zbGljZSgpO1xuICAgIGxlbiA9IGxpc3RlbmVycy5sZW5ndGg7XG4gICAgZm9yIChpID0gMDsgaSA8IGxlbjsgaSsrKVxuICAgICAgbGlzdGVuZXJzW2ldLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICB9XG5cbiAgcmV0dXJuIHRydWU7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmFkZExpc3RlbmVyID0gZnVuY3Rpb24odHlwZSwgbGlzdGVuZXIpIHtcbiAgdmFyIG07XG5cbiAgaWYgKCFpc0Z1bmN0aW9uKGxpc3RlbmVyKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ2xpc3RlbmVyIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzKVxuICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuXG4gIC8vIFRvIGF2b2lkIHJlY3Vyc2lvbiBpbiB0aGUgY2FzZSB0aGF0IHR5cGUgPT09IFwibmV3TGlzdGVuZXJcIiEgQmVmb3JlXG4gIC8vIGFkZGluZyBpdCB0byB0aGUgbGlzdGVuZXJzLCBmaXJzdCBlbWl0IFwibmV3TGlzdGVuZXJcIi5cbiAgaWYgKHRoaXMuX2V2ZW50cy5uZXdMaXN0ZW5lcilcbiAgICB0aGlzLmVtaXQoJ25ld0xpc3RlbmVyJywgdHlwZSxcbiAgICAgICAgICAgICAgaXNGdW5jdGlvbihsaXN0ZW5lci5saXN0ZW5lcikgP1xuICAgICAgICAgICAgICBsaXN0ZW5lci5saXN0ZW5lciA6IGxpc3RlbmVyKTtcblxuICBpZiAoIXRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICAvLyBPcHRpbWl6ZSB0aGUgY2FzZSBvZiBvbmUgbGlzdGVuZXIuIERvbid0IG5lZWQgdGhlIGV4dHJhIGFycmF5IG9iamVjdC5cbiAgICB0aGlzLl9ldmVudHNbdHlwZV0gPSBsaXN0ZW5lcjtcbiAgZWxzZSBpZiAoaXNPYmplY3QodGhpcy5fZXZlbnRzW3R5cGVdKSlcbiAgICAvLyBJZiB3ZSd2ZSBhbHJlYWR5IGdvdCBhbiBhcnJheSwganVzdCBhcHBlbmQuXG4gICAgdGhpcy5fZXZlbnRzW3R5cGVdLnB1c2gobGlzdGVuZXIpO1xuICBlbHNlXG4gICAgLy8gQWRkaW5nIHRoZSBzZWNvbmQgZWxlbWVudCwgbmVlZCB0byBjaGFuZ2UgdG8gYXJyYXkuXG4gICAgdGhpcy5fZXZlbnRzW3R5cGVdID0gW3RoaXMuX2V2ZW50c1t0eXBlXSwgbGlzdGVuZXJdO1xuXG4gIC8vIENoZWNrIGZvciBsaXN0ZW5lciBsZWFrXG4gIGlmIChpc09iamVjdCh0aGlzLl9ldmVudHNbdHlwZV0pICYmICF0aGlzLl9ldmVudHNbdHlwZV0ud2FybmVkKSB7XG4gICAgdmFyIG07XG4gICAgaWYgKCFpc1VuZGVmaW5lZCh0aGlzLl9tYXhMaXN0ZW5lcnMpKSB7XG4gICAgICBtID0gdGhpcy5fbWF4TGlzdGVuZXJzO1xuICAgIH0gZWxzZSB7XG4gICAgICBtID0gRXZlbnRFbWl0dGVyLmRlZmF1bHRNYXhMaXN0ZW5lcnM7XG4gICAgfVxuXG4gICAgaWYgKG0gJiYgbSA+IDAgJiYgdGhpcy5fZXZlbnRzW3R5cGVdLmxlbmd0aCA+IG0pIHtcbiAgICAgIHRoaXMuX2V2ZW50c1t0eXBlXS53YXJuZWQgPSB0cnVlO1xuICAgICAgY29uc29sZS5lcnJvcignKG5vZGUpIHdhcm5pbmc6IHBvc3NpYmxlIEV2ZW50RW1pdHRlciBtZW1vcnkgJyArXG4gICAgICAgICAgICAgICAgICAgICdsZWFrIGRldGVjdGVkLiAlZCBsaXN0ZW5lcnMgYWRkZWQuICcgK1xuICAgICAgICAgICAgICAgICAgICAnVXNlIGVtaXR0ZXIuc2V0TWF4TGlzdGVuZXJzKCkgdG8gaW5jcmVhc2UgbGltaXQuJyxcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzW3R5cGVdLmxlbmd0aCk7XG4gICAgICBpZiAodHlwZW9mIGNvbnNvbGUudHJhY2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgLy8gbm90IHN1cHBvcnRlZCBpbiBJRSAxMFxuICAgICAgICBjb25zb2xlLnRyYWNlKCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLm9uID0gRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5hZGRMaXN0ZW5lcjtcblxuRXZlbnRFbWl0dGVyLnByb3RvdHlwZS5vbmNlID0gZnVuY3Rpb24odHlwZSwgbGlzdGVuZXIpIHtcbiAgaWYgKCFpc0Z1bmN0aW9uKGxpc3RlbmVyKSlcbiAgICB0aHJvdyBUeXBlRXJyb3IoJ2xpc3RlbmVyIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuXG4gIHZhciBmaXJlZCA9IGZhbHNlO1xuXG4gIGZ1bmN0aW9uIGcoKSB7XG4gICAgdGhpcy5yZW1vdmVMaXN0ZW5lcih0eXBlLCBnKTtcblxuICAgIGlmICghZmlyZWQpIHtcbiAgICAgIGZpcmVkID0gdHJ1ZTtcbiAgICAgIGxpc3RlbmVyLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfVxuICB9XG5cbiAgZy5saXN0ZW5lciA9IGxpc3RlbmVyO1xuICB0aGlzLm9uKHR5cGUsIGcpO1xuXG4gIHJldHVybiB0aGlzO1xufTtcblxuLy8gZW1pdHMgYSAncmVtb3ZlTGlzdGVuZXInIGV2ZW50IGlmZiB0aGUgbGlzdGVuZXIgd2FzIHJlbW92ZWRcbkV2ZW50RW1pdHRlci5wcm90b3R5cGUucmVtb3ZlTGlzdGVuZXIgPSBmdW5jdGlvbih0eXBlLCBsaXN0ZW5lcikge1xuICB2YXIgbGlzdCwgcG9zaXRpb24sIGxlbmd0aCwgaTtcblxuICBpZiAoIWlzRnVuY3Rpb24obGlzdGVuZXIpKVxuICAgIHRocm93IFR5cGVFcnJvcignbGlzdGVuZXIgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG5cbiAgaWYgKCF0aGlzLl9ldmVudHMgfHwgIXRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICByZXR1cm4gdGhpcztcblxuICBsaXN0ID0gdGhpcy5fZXZlbnRzW3R5cGVdO1xuICBsZW5ndGggPSBsaXN0Lmxlbmd0aDtcbiAgcG9zaXRpb24gPSAtMTtcblxuICBpZiAobGlzdCA9PT0gbGlzdGVuZXIgfHxcbiAgICAgIChpc0Z1bmN0aW9uKGxpc3QubGlzdGVuZXIpICYmIGxpc3QubGlzdGVuZXIgPT09IGxpc3RlbmVyKSkge1xuICAgIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG4gICAgaWYgKHRoaXMuX2V2ZW50cy5yZW1vdmVMaXN0ZW5lcilcbiAgICAgIHRoaXMuZW1pdCgncmVtb3ZlTGlzdGVuZXInLCB0eXBlLCBsaXN0ZW5lcik7XG5cbiAgfSBlbHNlIGlmIChpc09iamVjdChsaXN0KSkge1xuICAgIGZvciAoaSA9IGxlbmd0aDsgaS0tID4gMDspIHtcbiAgICAgIGlmIChsaXN0W2ldID09PSBsaXN0ZW5lciB8fFxuICAgICAgICAgIChsaXN0W2ldLmxpc3RlbmVyICYmIGxpc3RbaV0ubGlzdGVuZXIgPT09IGxpc3RlbmVyKSkge1xuICAgICAgICBwb3NpdGlvbiA9IGk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChwb3NpdGlvbiA8IDApXG4gICAgICByZXR1cm4gdGhpcztcblxuICAgIGlmIChsaXN0Lmxlbmd0aCA9PT0gMSkge1xuICAgICAgbGlzdC5sZW5ndGggPSAwO1xuICAgICAgZGVsZXRlIHRoaXMuX2V2ZW50c1t0eXBlXTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGlzdC5zcGxpY2UocG9zaXRpb24sIDEpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLl9ldmVudHMucmVtb3ZlTGlzdGVuZXIpXG4gICAgICB0aGlzLmVtaXQoJ3JlbW92ZUxpc3RlbmVyJywgdHlwZSwgbGlzdGVuZXIpO1xuICB9XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLnJlbW92ZUFsbExpc3RlbmVycyA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgdmFyIGtleSwgbGlzdGVuZXJzO1xuXG4gIGlmICghdGhpcy5fZXZlbnRzKVxuICAgIHJldHVybiB0aGlzO1xuXG4gIC8vIG5vdCBsaXN0ZW5pbmcgZm9yIHJlbW92ZUxpc3RlbmVyLCBubyBuZWVkIHRvIGVtaXRcbiAgaWYgKCF0aGlzLl9ldmVudHMucmVtb3ZlTGlzdGVuZXIpIHtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMClcbiAgICAgIHRoaXMuX2V2ZW50cyA9IHt9O1xuICAgIGVsc2UgaWYgKHRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICAgIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvLyBlbWl0IHJlbW92ZUxpc3RlbmVyIGZvciBhbGwgbGlzdGVuZXJzIG9uIGFsbCBldmVudHNcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApIHtcbiAgICBmb3IgKGtleSBpbiB0aGlzLl9ldmVudHMpIHtcbiAgICAgIGlmIChrZXkgPT09ICdyZW1vdmVMaXN0ZW5lcicpIGNvbnRpbnVlO1xuICAgICAgdGhpcy5yZW1vdmVBbGxMaXN0ZW5lcnMoa2V5KTtcbiAgICB9XG4gICAgdGhpcy5yZW1vdmVBbGxMaXN0ZW5lcnMoJ3JlbW92ZUxpc3RlbmVyJyk7XG4gICAgdGhpcy5fZXZlbnRzID0ge307XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBsaXN0ZW5lcnMgPSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgaWYgKGlzRnVuY3Rpb24obGlzdGVuZXJzKSkge1xuICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIodHlwZSwgbGlzdGVuZXJzKTtcbiAgfSBlbHNlIHtcbiAgICAvLyBMSUZPIG9yZGVyXG4gICAgd2hpbGUgKGxpc3RlbmVycy5sZW5ndGgpXG4gICAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKHR5cGUsIGxpc3RlbmVyc1tsaXN0ZW5lcnMubGVuZ3RoIC0gMV0pO1xuICB9XG4gIGRlbGV0ZSB0aGlzLl9ldmVudHNbdHlwZV07XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5FdmVudEVtaXR0ZXIucHJvdG90eXBlLmxpc3RlbmVycyA9IGZ1bmN0aW9uKHR5cGUpIHtcbiAgdmFyIHJldDtcbiAgaWYgKCF0aGlzLl9ldmVudHMgfHwgIXRoaXMuX2V2ZW50c1t0eXBlXSlcbiAgICByZXQgPSBbXTtcbiAgZWxzZSBpZiAoaXNGdW5jdGlvbih0aGlzLl9ldmVudHNbdHlwZV0pKVxuICAgIHJldCA9IFt0aGlzLl9ldmVudHNbdHlwZV1dO1xuICBlbHNlXG4gICAgcmV0ID0gdGhpcy5fZXZlbnRzW3R5cGVdLnNsaWNlKCk7XG4gIHJldHVybiByZXQ7XG59O1xuXG5FdmVudEVtaXR0ZXIubGlzdGVuZXJDb3VudCA9IGZ1bmN0aW9uKGVtaXR0ZXIsIHR5cGUpIHtcbiAgdmFyIHJldDtcbiAgaWYgKCFlbWl0dGVyLl9ldmVudHMgfHwgIWVtaXR0ZXIuX2V2ZW50c1t0eXBlXSlcbiAgICByZXQgPSAwO1xuICBlbHNlIGlmIChpc0Z1bmN0aW9uKGVtaXR0ZXIuX2V2ZW50c1t0eXBlXSkpXG4gICAgcmV0ID0gMTtcbiAgZWxzZVxuICAgIHJldCA9IGVtaXR0ZXIuX2V2ZW50c1t0eXBlXS5sZW5ndGg7XG4gIHJldHVybiByZXQ7XG59O1xuXG5mdW5jdGlvbiBpc0Z1bmN0aW9uKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Z1bmN0aW9uJztcbn1cblxuZnVuY3Rpb24gaXNOdW1iZXIoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnbnVtYmVyJztcbn1cblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09PSB2b2lkIDA7XG59XG4iLCJleHBvcnQgZnVuY3Rpb24gYWpheChvcHRpb25zKSB7XG4gIGxldCB7IG1ldGhvZCwgdXJsLCBkYXRhIH0gPSBvcHRpb25zO1xuXG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgbGV0IHhociA9IG5ldyBYTUxIdHRwUmVxdWVzdCgpO1xuICBcbiAgICB4aHIub3BlbihtZXRob2QsIHdpbmRvdy5sb2NhdGlvbi5vcmlnaW4gKyB1cmwpO1xuICAgIHhoci5vbmxvYWQgPSAoKSA9PiB7XG4gICAgICBpZiAoeGhyLnN0YXR1cyA9PSAyMDApIFxuICAgICAgICByZXNvbHZlKHhoci5yZXNwb25zZVRleHQpO1xuICAgICAgZWxzZSBcbiAgICAgICAgcmVqZWN0KEVycm9yKHhoci5zdGF0dXNUZXh0KSk7XG4gICAgfTtcbiAgICB4aHIub25lcnJvciA9ICgpID0+IHtcbiAgICAgIHJlamVjdChFcnJvcignTmV0d29yayBFcnJvcicpKTtcbiAgICB9O1xuICAgIHhoci5zZW5kKGRhdGEpO1xuICB9KTtcbn0iLCJjb25zb2xlLmxvZygnZGF0IHdvcmsnKTtcblxuaW1wb3J0IGEgZnJvbSAnYWJ5c3NhJztcbmltcG9ydCBhamF4IGZyb20gJy4vdXRpbHMvYWpheCc7XG5cblxubGV0IHJvdXRlciA9IGEuUm91dGVyKHtcbiAgaG9tZTogYS5TdGF0ZSgnLycsIHtcbiAgICBlbnRlcjogZnVuY3Rpb24ocGFyYW1zKSB7XG4gICAgICBjb25zb2xlLmxvZygnZW50ZXIgaG9tZScsIHBhcmFtcy5pZCk7XG4gICAgfSxcbiAgICBleGl0OiBmdW5jdGlvbigpIHtcbiAgICAgIGNvbnNvbGUubG9nKCdsZWF2ZSBob21lJyk7XG4gICAgfVxuICB9LHtcbiAgICBwb3N0OiBhLlN0YXRlKCc6aWQnLCB7XG4gICAgICBlbnRlcjogZnVuY3Rpb24ocGFyYW1zKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKCdlbnRlciBwb3N0JywgcGFyYW1zLmlkKTtcbiAgICAgICAgLy8gYWpheChwYXJhbXMuaWQsIHJlcyA9PiByZXMpO1xuICAgICAgfSxcbiAgICAgIGV4aXQ6IGZ1bmN0aW9uKCkge1xuICAgICAgICBjb25zb2xlLmxvZygnbGVhdmUgcG9zdCcpO1xuICAgICAgfVxuICAgIH0pXG4gIH0pLFxuICB0YWc6IGEuU3RhdGUoJ3RhZy86aWQnLCB7XG4gICAgZW50ZXI6IGZ1bmN0aW9uKHBhcmFtcykge1xuICAgICAgY29uc29sZS5sb2coJ2VudGVyIHRhZycsICd0YWcvJysgcGFyYW1zLmlkKTtcbiAgICB9LFxuICAgIGV4aXQ6IGZ1bmN0aW9uKCkge1xuICAgICAgY29uc29sZS5sb2coJ2xlYXZlIHRhZycpO1xuICAgIH1cbiAgfSksXG4gIGF1dGhvcjogYS5TdGF0ZSgnYXV0aG9yLzppZCcsIHtcbiAgICBlbnRlcjogZnVuY3Rpb24ocGFyYW1zKSB7XG4gICAgICBjb25zb2xlLmxvZygnZW50ZXIgYXV0aG9yJywgJ2F1dGhvci8nKyBwYXJhbXMuaWQpO1xuICAgIH0sXG4gICAgZXhpdDogZnVuY3Rpb24oKSB7XG4gICAgICBjb25zb2xlLmxvZygnbGVhdmUgYXV0aG9yJyk7XG4gICAgfVxuICB9KVxufSkuaW5pdCgpOyJdfQ==
