/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactEventEmitterMixin
 */

'use strict';

var EventPluginHub = require('EventPluginHub');

function runEventQueueInBatch(events) {
  // 先将events事件放入队列中
  EventPluginHub.enqueueEvents(events);
  //触发该事件队列中的所有事件
  EventPluginHub.processEventQueue(false);
}

var ReactEventEmitterMixin = {
  /**
   * Streams a fired top-level event to `EventPluginHub` where plugins have the
   * opportunity to create `ReactEvent`s to be dispatched.
   */
  handleTopLevel: function(
    topLevelType,
    targetInst,
    nativeEvent,
    nativeEventTarget,
  ) {
    //获取具体事件
    var events = EventPluginHub.extractEvents(
      topLevelType,
      targetInst,
      nativeEvent,
      nativeEventTarget,
    );
    //将事件放入队列中
    runEventQueueInBatch(events);
  },
};

module.exports = ReactEventEmitterMixin;
