/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactEventListener
 */

'use strict';

var EventListener = require('EventListener');
var ExecutionEnvironment = require('ExecutionEnvironment');
var PooledClass = require('PooledClass');
var ReactDOMComponentTree = require('ReactDOMComponentTree');
var ReactUpdates = require('ReactUpdates');

var getEventTarget = require('getEventTarget');
var getUnboundedScrollPosition = require('getUnboundedScrollPosition');

/**
 * Find the deepest React component completely containing the root of the
 * passed-in instance (for use when entire React trees are nested within each
 * other). If React trees are not nested, returns null.
 */
function findParent(inst) {
  // TODO: It may be a good idea to cache this to prevent unnecessary DOM
  // traversal, but caching is difficult to do correctly without using a
  // mutation observer to listen for all DOM changes.
  while (inst._hostParent) {
    inst = inst._hostParent;
  }
  var rootNode = ReactDOMComponentTree.getNodeFromInstance(inst);
  var container = rootNode.parentNode;
  return ReactDOMComponentTree.getClosestInstanceFromNode(container);
}

// Used to store ancestor hierarchy in top level callback
function TopLevelCallbackBookKeeping(topLevelType, nativeEvent) {
  this.topLevelType = topLevelType;
  this.nativeEvent = nativeEvent;
  this.ancestors = [];
}
Object.assign(TopLevelCallbackBookKeeping.prototype, {
  destructor: function() {
    this.topLevelType = null;
    this.nativeEvent = null;
    this.ancestors.length = 0;
  },
});
PooledClass.addPoolingTo(
  TopLevelCallbackBookKeeping,
  PooledClass.twoArgumentPooler,
);

function handleTopLevelImpl(bookKeeping) {
  // 获取这个event的真是dom元素，如果是text节点，则返回父容器
  var nativeEventTarget = getEventTarget(bookKeeping.nativeEvent);
  // 获取事件节点所对应的react实例
  var targetInst = ReactDOMComponentTree.getClosestInstanceFromNode(
    nativeEventTarget,
  );

  var ancestor = targetInst;
  // 将该组件所有父节点放入ancestors，因为事件可能会改变父节点结构，因此在执行事件回调之前缓存当前parent
  do {
    bookKeeping.ancestors.push(ancestor);
    ancestor = ancestor && findParent(ancestor);
  } while (ancestor);


  for (var i = 0; i < bookKeeping.ancestors.length; i++) {
    targetInst = bookKeeping.ancestors[i];
    // 从当前组件开始执行注册的事件，模拟冒泡操作
    ReactEventListener._handleTopLevel(
      bookKeeping.topLevelType,
      targetInst,
      bookKeeping.nativeEvent,
      getEventTarget(bookKeeping.nativeEvent),
    );
  }
}

function scrollValueMonitor(cb) {
  var scrollPosition = getUnboundedScrollPosition(window);
  cb(scrollPosition);
}

var ReactEventListener = {
  _enabled: true,
  _handleTopLevel: null,

  WINDOW_HANDLE: ExecutionEnvironment.canUseDOM ? window : null,

  setHandleTopLevel: function(handleTopLevel) {
    ReactEventListener._handleTopLevel = handleTopLevel;
  },

  setEnabled: function(enabled) {
    ReactEventListener._enabled = !!enabled;
  },

  isEnabled: function() {
    return ReactEventListener._enabled;
  },

  /**
   * Traps top-level events by using event bubbling.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {string} handlerBaseName Event name (e.g. "click").
   * @param {object} element Element on which to attach listener.
   * @return {?object} An object with a remove function which will forcefully
   *                  remove the listener.
   * @internal
   */
  trapBubbledEvent: function(topLevelType, handlerBaseName, element) {
    if (!element) {
      return null;
    }
    return EventListener.listen(
      element,
      handlerBaseName,
      //事件回调，注意
      ReactEventListener.dispatchEvent.bind(null, topLevelType),
    );
  },

  /**
   * Traps a top-level event by using event capturing.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {string} handlerBaseName Event name (e.g. "click").
   * @param {object} element Element on which to attach listener.
   * @return {?object} An object with a remove function which will forcefully
   *                  remove the listener.
   * @internal
   */
  trapCapturedEvent: function(topLevelType, handlerBaseName, element) {
    if (!element) {
      return null;
    }
    return EventListener.capture(
      element,
      handlerBaseName,
      ReactEventListener.dispatchEvent.bind(null, topLevelType),
    );
  },

  monitorScrollValue: function(refresh) {
    var callback = scrollValueMonitor.bind(null, refresh);
    EventListener.listen(window, 'scroll', callback);
  },

  dispatchEvent: function(topLevelType, nativeEvent) {
    if (!ReactEventListener._enabled) {
      return;
    }

    var bookKeeping = TopLevelCallbackBookKeeping.getPooled(
      topLevelType,
      nativeEvent,
    );
    try {
      // Event queue being processed in the same cycle allows
      // `preventDefault`.
      ReactUpdates.batchedUpdates(handleTopLevelImpl, bookKeeping);
    } finally {
      TopLevelCallbackBookKeeping.release(bookKeeping);
    }
  },
};

module.exports = ReactEventListener;
