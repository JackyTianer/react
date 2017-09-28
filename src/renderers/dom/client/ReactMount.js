/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactMount
 */

'use strict';

var DOMLazyTree = require('DOMLazyTree');
var DOMProperty = require('DOMProperty');
var React = require('React');
var ReactBrowserEventEmitter = require('ReactBrowserEventEmitter');
var ReactCurrentOwner = require('ReactCurrentOwner');
var ReactDOMComponentTree = require('ReactDOMComponentTree');
var ReactDOMContainerInfo = require('ReactDOMContainerInfo');
var ReactDOMFeatureFlags = require('ReactDOMFeatureFlags');
var ReactFeatureFlags = require('ReactFeatureFlags');
var ReactInstanceMap = require('ReactInstanceMap');
var ReactInstrumentation = require('ReactInstrumentation');
var ReactMarkupChecksum = require('ReactMarkupChecksum');
var ReactReconciler = require('ReactReconciler');
var ReactUpdateQueue = require('ReactUpdateQueue');
var ReactUpdates = require('ReactUpdates');

var emptyObject = require('emptyObject');
var instantiateReactComponent = require('instantiateReactComponent');
var invariant = require('invariant');
var setInnerHTML = require('setInnerHTML');
var shouldUpdateReactComponent = require('shouldUpdateReactComponent');
var warning = require('warning');

var ATTR_NAME = DOMProperty.ID_ATTRIBUTE_NAME;
var ROOT_ATTR_NAME = DOMProperty.ROOT_ATTRIBUTE_NAME;

var ELEMENT_NODE_TYPE = 1;
var DOC_NODE_TYPE = 9;
var DOCUMENT_FRAGMENT_NODE_TYPE = 11;

var instancesByReactRootID = {};

/**
 * Finds the index of the first character
 * that's not common between the two given strings.
 *
 * @return {number} the index of the character where the strings diverge
 */
function firstDifferenceIndex(string1, string2) {
  var minLen = Math.min(string1.length, string2.length);
  for (var i = 0; i < minLen; i++) {
    if (string1.charAt(i) !== string2.charAt(i)) {
      return i;
    }
  }
  return string1.length === string2.length ? -1 : minLen;
}

/**
 * @param {DOMElement|DOMDocument} container DOM element that may contain
 * a React component
 * @return {?*} DOM element that may have the reactRoot ID, or null.
 */
function getReactRootElementInContainer(container) {
  if (!container) {
    return null;
  }

  /**
   * 如果container是document的话返回documentElement即html元素
   * 详见 [documentElement](https://developer.mozilla.org/zh-CN/docs/Web/API/Document/documentElement)
   * 否则返回容器的firstChild
   */

  if (container.nodeType === DOC_NODE_TYPE) {
    return container.documentElement;
  } else {
    return container.firstChild;
  }
}

function internalGetID(node) {
  // If node is something like a window, document, or text node, none of
  // which support attributes or a .getAttribute method, gracefully return
  // the empty string, as if the attribute were missing.
  return (node.getAttribute && node.getAttribute(ATTR_NAME)) || '';
}

/**
 * Mounts this component and inserts it into the DOM.
 *
 * @param {ReactComponent} componentInstance The instance to mount.
 * @param {DOMElement} container DOM element to mount into.
 * @param {ReactReconcileTransaction} transaction
 * @param {boolean} shouldReuseMarkup If true, do not insert markup
 */
function mountComponentIntoNode(
  wrapperInstance,
  container,
  transaction,
  shouldReuseMarkup,
  context,
) {
  /*调用刚才ReactComponent instance中mountComponent方法，将React组件解析成对应的html（对应不同ReactComponent instance）mountComponent也是不同的
   <div>hello react</div>, 对应的是ReactDOMTextComponent，最终解析成的HTML为<div data-reactroot="x.x.x">hello react</div>
   */
  var markup = ReactReconciler.mountComponent(
    wrapperInstance,
    transaction,
    null,
    ReactDOMContainerInfo(wrapperInstance, container),
    context,
    0 /* parentDebugID */,
  );

  wrapperInstance._renderedComponent._topLevelWrapper = wrapperInstance;
  /**
   * 将解析出来的html插入到dom中
   */
  ReactMount._mountImageIntoNode(
    markup,
    container,
    wrapperInstance,
    shouldReuseMarkup,
    transaction,
  );
}

/**
 * Batched mount.
 *
 * @param {ReactComponent} componentInstance The instance to mount.
 * @param {DOMElement} container DOM element to mount into.
 * @param {boolean} shouldReuseMarkup If true, do not insert markup
 */
// TODO book mark1
function batchedMountComponentIntoNode(
  componentInstance,
  container,
  shouldReuseMarkup,
  context,
) {
  var transaction = ReactUpdates.ReactReconcileTransaction.getPooled(
    /* useCreateElement */
    !shouldReuseMarkup && ReactDOMFeatureFlags.useCreateElement,
  );
  transaction.perform(
    mountComponentIntoNode,
    null,
    componentInstance,
    container,
    transaction,
    shouldReuseMarkup,
    context,
  );
  ReactUpdates.ReactReconcileTransaction.release(transaction);
}

/**
 * Unmounts a component and removes it from the DOM.
 *
 * @param {ReactComponent} instance React component instance.
 * @param {DOMElement} container DOM element to unmount from.
 * @final
 * @internal
 * @see {ReactMount.unmountComponentAtNode}
 */
function unmountComponentFromNode(instance, container, safely) {
  ReactReconciler.unmountComponent(instance, safely);

  if (container.nodeType === DOC_NODE_TYPE) {
    container = container.documentElement;
  }

  // http://jsperf.com/emptying-a-node
  while (container.lastChild) {
    container.removeChild(container.lastChild);
  }
}

/**
 * True if the supplied DOM node has a direct React-rendered child that is
 * not a React root element. Useful for warning in `render`,
 * `unmountComponentAtNode`, etc.
 *
 * @param {?DOMElement} node The candidate DOM node.
 * @return {boolean} True if the DOM element contains a direct child that was
 * rendered by React but is not a root element.
 * @internal
 */
function hasNonRootReactChild(container) {
  var rootEl = getReactRootElementInContainer(container);
  if (rootEl) {
    var inst = ReactDOMComponentTree.getInstanceFromNode(rootEl);
    return !!(inst && inst._hostParent);
  }
}

/**
 * True if the supplied DOM node is a React DOM element and
 * it has been rendered by another copy of React.
 *
 * @param {?DOMElement} node The candidate DOM node.
 * @return {boolean} True if the DOM has been rendered by another copy of React
 * @internal
 */
function nodeIsRenderedByOtherInstance(container) {
  var rootEl = getReactRootElementInContainer(container);
  return !!(
    rootEl &&
    isReactNode(rootEl) &&
    !ReactDOMComponentTree.getInstanceFromNode(rootEl)
  );
}

/**
 * True if the supplied DOM node is a valid node element.
 *
 * @param {?DOMElement} node The candidate DOM node.
 * @return {boolean} True if the DOM is a valid DOM node.
 * @internal
 */
function isValidContainer(node) {
  return !!(
    node &&
    (node.nodeType === ELEMENT_NODE_TYPE ||
      node.nodeType === DOC_NODE_TYPE ||
      node.nodeType === DOCUMENT_FRAGMENT_NODE_TYPE)
  );
}

/**
 * True if the supplied DOM node is a valid React node element.
 *
 * @param {?DOMElement} node The candidate DOM node.
 * @return {boolean} True if the DOM is a valid React DOM node.
 * @internal
 */
function isReactNode(node) {
  return (
    isValidContainer(node) &&
    (node.hasAttribute(ROOT_ATTR_NAME) || node.hasAttribute(ATTR_NAME))
  );
}

function getHostRootInstanceInContainer(container) {
  // 获取插入的容器元素
  var rootEl = getReactRootElementInContainer(container);

  // 如果rootEl存在 prevHostInstance =  ReactDOMComponentTree.getInstanceFromNode(rootEl)
  var prevHostInstance =
    rootEl && ReactDOMComponentTree.getInstanceFromNode(rootEl);
  return prevHostInstance && !prevHostInstance._hostParent
    ? prevHostInstance
    : null;
}

function getTopLevelWrapperInContainer(container) {
  var root = getHostRootInstanceInContainer(container);
  return root ? root._hostContainerInfo._topLevelWrapper : null;
}

/**
 * Temporary (?) hack so that we can store all top-level pending updates on
 * composites instead of having to worry about different types of components
 * here.
 */
var topLevelRootCounter = 1;
var TopLevelWrapper = function() {
  this.rootID = topLevelRootCounter++;
};
TopLevelWrapper.prototype.isReactComponent = {};
TopLevelWrapper.prototype.render = function() {
  return this.props.child;
};
TopLevelWrapper.isReactTopLevelWrapper = true;

/**
 * Mounting is the process of initializing a React component by creating its
 * representative DOM elements and inserting them into a supplied `container`.
 * Any prior content inside `container` is destroyed in the process.
 *
 *   ReactMount.render(
 *     component,
 *     document.getElementById('container')
 *   );
 *
 *   <div id="container">                   <-- Supplied `container`.
 *     <div data-reactid=".3">              <-- Rendered reactRoot of React
 *       // ...                                 component.
 *     </div>
 *   </div>
 *
 * Inside of `container`, the first element rendered is the "reactRoot".
 */
var ReactMount = {
  TopLevelWrapper: TopLevelWrapper,

  /**
   * Used by devtools. The keys are not important.
   */
  _instancesByReactRootID: instancesByReactRootID,

  /**
   * This is a hook provided to support rendering React components while
   * ensuring that the apparent scroll position of its `container` does not
   * change.
   *
   * @param {DOMElement} container The `container` being rendered into.
   * @param {function} renderCallback This must be called once to do the render.
   */
  scrollMonitor: function(container, renderCallback) {
    renderCallback();
  },

  /**
   * Take a component that's already mounted into the DOM and replace its props
   * @param {ReactComponent} prevComponent component instance already in the DOM
   * @param {ReactElement} nextElement component instance to render
   * @param {DOMElement} container container to render into
   * @param {?function} callback function triggered on completion
   */
  _updateRootComponent: function(
    prevComponent,
    nextElement,
    nextContext,
    container,
    callback,
  ) {
    ReactMount.scrollMonitor(container, function() {
      ReactUpdateQueue.enqueueElementInternal(
        prevComponent,
        nextElement,
        nextContext,
      );
      if (callback) {
        ReactUpdateQueue.enqueueCallbackInternal(prevComponent, callback);
      }
    });

    return prevComponent;
  },

  /**
   * Render a new component into the DOM. Hooked by hooks!
   *
   * @param {ReactElement} nextElement 即将渲染的组件
   * @param {DOMElement} container 容器元素
   * @param {boolean} shouldReuseMarkup 是否需要重新标记元素
   * @return {ReactComponent} nextComponent 返回一个ReactComponent
   */
  _renderNewRootComponent: function(
    nextElement,
    container,
    shouldReuseMarkup,
    context,
  ) {
    //主要和滚动条有关，目前不需要太关心
    ReactBrowserEventEmitter.ensureScrollValueMonitoring();
    //初始化React Component,简单来说会返回一个类似于封装过后的ReactCompont对象，其中包含了MountComponent等方法，以及将nextElement放入_currentElement之中
    var componentInstance = instantiateReactComponent(nextElement, false);
    /*
     上文instantiateReactComponent
     function instantiateReactComponent(node, shouldHaveDebugID) {
     var instance;

     if (node === null || node === false) {
     // 如果是空对象
     instance = ReactEmptyComponent.create(instantiateReactComponent);
     } else if (typeof node === 'object') {
     // 如果是Node,（包括dom节点以及reactElement）
     var element = node;

     // 原生对象
     if (typeof element.type === 'string') {
     instance = ReactHostComponent.createInternalComponent(element);
     } else {
     // react组件
     instance = new ReactCompositeComponentWrapper(element);
     }
     //如果元素本来就是一个string或者number，如 <div>111</div>中的111
     } else if (typeof node === 'string' || typeof node === 'number') {
     //创建一个
     instance = ReactHostComponent.createInstanceForText(node);
     }

     //这两个参数用于dom 和 art diff算法
     instance._mountIndex = 0;
     instance._mountImage = null;
     return instance;
     }
     */


    /* 批量更新方法，具体实现可以见 ReactDefaultBatchingStrategy.js中 batchedUpdate方法，实际就是执行
     * batchedMountComponentIntoNode方法，将后面的参数传入batchedMountComponentIntoNode中

     */
    ReactUpdates.batchedUpdates(
      batchedMountComponentIntoNode,
      componentInstance,
      container,
      shouldReuseMarkup,
      context,
    );

    var wrapperID = componentInstance._instance.rootID;
    instancesByReactRootID[wrapperID] = componentInstance;

    return componentInstance;
  },

  /**
   * Renders a React component into the DOM in the supplied `container`.
   *
   * If the React component was previously rendered into `container`, this will
   * perform an update on it and only mutate the DOM as necessary to reflect the
   * latest React component.
   *
   * @param {ReactComponent} parentComponent 父组件，对于调用ReactDOM.render时，传入为true
   * @param {ReactElement} nextElement 插入到DOM中的React元素
   * @param {DOMElement} container 插入的DOM容器元素.
   * @param {?function} callback 当成功后触发的回调函数。
   * @return {ReactComponent} 返回ReactComponent实例
   */
  renderSubtreeIntoContainer: function(
    parentComponent,
    nextElement,
    container,
    callback,
  ) {
    return ReactMount._renderSubtreeIntoContainer(
      parentComponent,
      nextElement,
      container,
      callback,
    );
  },

  // ReactDom.render调用后 第一个参数默认传递null，因为该方法第一个参数是父组件，剩下三个参数和render函数一致
  _renderSubtreeIntoContainer: function(
    parentComponent,
    nextElement,
    container,
    callback,
  ) {
    //判断callback是否为函数;
    ReactUpdateQueue.validateCallback(callback, 'ReactDOM.render');

    //通过TopLevelWrapper创建一个ReactElement节点，并且设置其this.props.child = render传入的ReactElement
    /** TopLevelWrapper代码
     var topLevelRootCounter = 1;z
     var TopLevelWrapper = function() {
      this.rootID = topLevelRootCounter++;
    };
     TopLevelWrapper.prototype.isReactComponent = {};
     TopLevelWrapper.prototype.render = function() {
      return this.props.child;
    };
     TopLevelWrapper.isReactTopLevelWrapper = true;
     */
      // 可以看出TopLevelWrapper代码就是一个简单的ReactComponent，类似于 extend React.Component, 并重写了方法render

    var nextWrappedElement = React.createElement(TopLevelWrapper, {
      child: nextElement,
    });

    var nextContext;
    // 如果存在父组件，即不是顶级组件的情况下（在ReactDOM.render时，parentComponent为null）
    if (parentComponent) {
      var parentInst = ReactInstanceMap.get(parentComponent);
      nextContext = parentInst._processChildContext(parentInst._context);
    } else {
      nextContext = emptyObject;
    }
    // 这时候preComponent = null;
    var prevComponent = getTopLevelWrapperInContainer(container);
    if (prevComponent) {
      //
      var prevWrappedElement = prevComponent._currentElement;
      var prevElement = prevWrappedElement.props.child;
      // diff 简单概括就是如果渲染的节点和原节点type和key（所以像listview可以通过设置key来进行优化）都不变的时候，直接更新就好，不用在去重新渲染一遍
      if (shouldUpdateReactComponent(prevElement, nextElement)) {
        var publicInst = prevComponent._renderedComponent.getPublicInstance();
        var updatedCallback =
          callback &&
          function() {
            callback.call(publicInst);
          };
        ReactMount._updateRootComponent(
          prevComponent,
          nextWrappedElement,
          nextContext,
          container,
          updatedCallback,
        );
        return publicInst;
      } else {
        //否则的话卸载掉该容器的组件
        ReactMount.unmountComponentAtNode(container);
      }
    }

    // 获取container的跟元素
    var reactRootElement = getReactRootElementInContainer(container);
    // 确定container是否被markup，即添加了data-reactid,第一次渲染肯定是false
    var containerHasReactMarkup =
      reactRootElement && !!internalGetID(reactRootElement);
    // 目前为false，因为ReactDOM.render调用时还没有实例化任何组件
    var containerHasNonRootReactChild = hasNonRootReactChild(container);


    // 目前为false
    var shouldReuseMarkup =
      containerHasReactMarkup &&
      !prevComponent &&
      !containerHasNonRootReactChild;
    // 关键代码，渲染，插入都在这里面
    var component = ReactMount._renderNewRootComponent(
      nextWrappedElement,
      container,
      shouldReuseMarkup,
      nextContext,
    )._renderedComponent.getPublicInstance();
    if (callback) {
      callback.call(component);
    }
    return component;
  },

  /**
   * Renders a React component into the DOM in the supplied `container`.
   * See https://facebook.github.io/react/docs/top-level-api.html#reactdom.render
   *
   * If the React component was previously rendered into `container`, this will
   * perform an update on it and only mutate the DOM as necessary to reflect the
   * latest React component.
   *
   * @param {ReactElement} nextElement Component element to render.
   * @param {DOMElement} container DOM element to render into.
   * @param {?function} callback function triggered on completion
   * @return {ReactComponent} Component instance rendered in `container`.
   */

  // nextElement即React Element
  // container 具体容器，将由virtualDOM生成的真实dom映射的位置
  // callback 渲染成功后的回调
  render: function(nextElement, container, callback) {
    return ReactMount._renderSubtreeIntoContainer(
      null,
      nextElement,
      container,
      callback,
    );
  },

  /**
   * Unmounts and destroys the React component rendered in the `container`.
   * See https://facebook.github.io/react/docs/top-level-api.html#reactdom.unmountcomponentatnode
   *
   * @param {DOMElement} container DOM element containing a React component.
   * @return {boolean} True if a component was found in and unmounted from
   *                   `container`
   */
  unmountComponentAtNode: function(container) {
    // Various parts of our code (such as ReactCompositeComponent's
    // _renderValidatedComponent) assume that calls to render aren't nested;
    // verify that that's the case. (Strictly speaking, unmounting won't cause a
    // render but we still don't expect to be in a render call here.)
    warning(
      ReactCurrentOwner.current == null,
      'unmountComponentAtNode(): Render methods should be a pure function ' +
        'of props and state; triggering nested component updates from render ' +
        'is not allowed. If necessary, trigger nested updates in ' +
        'componentDidUpdate. Check the render method of %s.',
      (ReactCurrentOwner.current && ReactCurrentOwner.current.getName()) ||
        'ReactCompositeComponent',
    );


    var prevComponent = getTopLevelWrapperInContainer(container);
    if (!prevComponent) {
      // Check if the node being unmounted was rendered by React, but isn't a
      // root node.
      var containerHasNonRootReactChild = hasNonRootReactChild(container);

      // Check if the container itself is a React root node.
      var isContainerReactRoot =
        container.nodeType === 1 && container.hasAttribute(ROOT_ATTR_NAME);


      return false;
    }
    delete instancesByReactRootID[prevComponent._instance.rootID];
    ReactUpdates.batchedUpdates(
      unmountComponentFromNode,
      prevComponent,
      container,
      false,
    );
    return true;
  },

  _mountImageIntoNode: function(
    markup,
    container,
    instance,
    shouldReuseMarkup,
    transaction,
  ) {

    if (shouldReuseMarkup) {
      var rootElement = getReactRootElementInContainer(container);
      if (ReactMarkupChecksum.canReuseMarkup(markup, rootElement)) {
        ReactDOMComponentTree.precacheNode(instance, rootElement);
        return;
      } else {
        var checksum = rootElement.getAttribute(
          ReactMarkupChecksum.CHECKSUM_ATTR_NAME,
        );
        rootElement.removeAttribute(ReactMarkupChecksum.CHECKSUM_ATTR_NAME);

        rootElement.setAttribute(
          ReactMarkupChecksum.CHECKSUM_ATTR_NAME,
          checksum,
        );
      }
    }

    //ReactDOM.render调用的时候该值为true
    if (transaction.useCreateElement) {
      //移除container中的节点
      while (container.lastChild) {
        container.removeChild(container.lastChild);
      }
      DOMLazyTree.insertTreeBefore(container, markup, null);
    } else {
      setInnerHTML(container, markup);
      ReactDOMComponentTree.precacheNode(instance, container.firstChild);
    }
  },
};

module.exports = ReactMount;
