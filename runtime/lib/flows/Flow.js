/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

var clone = require("clone");
var redUtil = require("@node-red/util").util;
const events = require("@node-red/util").events;
var flowUtil = require("./util");
const context = require('../nodes/context');
const hooks = require("@node-red/util").hooks;
const credentials = require("../nodes/credentials");

var Subflow;
var Log;

var nodeCloseTimeout = 15000;
var asyncMessageDelivery = true;

/**
 * This class represents a flow within the runtime. It is responsible for
 * creating, starting and stopping all nodes within the flow.
 */
class Flow {

    /**
     * Create a Flow object.
     * @param {[type]} parent     The parent flow
     * @param {[type]} globalFlow The global flow definition
     * @param {[type]} flow       This flow's definition
     */
    constructor(parent,globalFlow,flow) {
        this.TYPE = 'flow';
        this.parent = parent;
        this.global = globalFlow;
        if (typeof flow === 'undefined') {
            this.flow = globalFlow;
            this.isGlobalFlow = true;
        } else {
            this.flow = flow;
            this.isGlobalFlow = false;
        }
        this.id = this.flow.id || "global";
        this.activeNodes = {};
        this.subflowInstanceNodes = {};
        this.catchNodes = [];
        this.statusNodes = [];
        this.path = this.id;
        // Ensure a context exists for this flow
        this.context = context.getFlowContext(this.id,this.parent.id);
    }

    /**
     * Log a debug-level message from this flow
     * @param  {[type]} msg [description]
     * @return {[type]}     [description]
     */
    debug(msg) {
        Log.log({
            id: this.id||"global",
            level: Log.DEBUG,
            type:this.TYPE,
            msg:msg
        })
    }

    /**
     * Log an error-level message from this flow
     * @param  {[type]} msg [description]
     * @return {[type]}     [description]
     */
    error(msg) {
        Log.log({
            id: this.id||"global",
            level: Log.ERROR,
            type:this.TYPE,
            msg:msg
        })
    }

    /**
     * Log a info-level message from this flow
     * @param  {[type]} msg [description]
     * @return {[type]}     [description]
     */
    info(msg) {
        Log.log({
            id: this.id||"global",
            level: Log.INFO,
            type:this.TYPE,
            msg:msg
        })
    }

    /**
     * Log a trace-level message from this flow
     * @param  {[type]} msg [description]
     * @return {[type]}     [description]
     */
    trace(msg) {
        Log.log({
            id: this.id||"global",
            level: Log.TRACE,
            type:this.TYPE,
            msg:msg
        })
    }

    /**
     * [log description]
     * @param  {[type]} msg [description]
     * @return {[type]}     [description]
     */
    log(msg) {
        if (!msg.path) {
            msg.path = this.path;
        }
        this.parent.log(msg);
    }

    /**
     * Start this flow.
     * The `diff` argument helps define what needs to be started in the case
     * of a modified-nodes/flows type deploy.
     * @param  {[type]} msg [description]
     * @return {[type]}     [description]
     */
    start(diff) {
        this.trace("start "+this.TYPE+" ["+this.path+"]");
        var node;
        var newNode;
        var id;
        this.catchNodes = [];
        this.statusNodes = [];
        this.completeNodeMap = {};

        var configNodes = Object.keys(this.flow.configs);
        var configNodeAttempts = {};
        while (configNodes.length > 0) {
            id = configNodes.shift();
            node = this.flow.configs[id];
            if (!this.activeNodes[id]) {
                if (node.d !== true) {
                    var readyToCreate = true;
                    // This node doesn't exist.
                    // Check it doesn't reference another non-existent config node
                    for (var prop in node) {
                        if (node.hasOwnProperty(prop) &&
                        prop !== 'id' &&
                        prop !== 'wires' &&
                        prop !== '_users' &&
                        this.flow.configs[node[prop]] &&
                        this.flow.configs[node[prop]].d !== true
                        ) {
                            if (!this.activeNodes[node[prop]]) {
                                // References a non-existent config node
                                // Add it to the back of the list to try again later
                                configNodes.push(id);
                                configNodeAttempts[id] = (configNodeAttempts[id]||0)+1;
                                if (configNodeAttempts[id] === 100) {
                                    throw new Error("Circular config node dependency detected: "+id);
                                }
                                readyToCreate = false;
                                break;
                            }
                        }
                    }
                    if (readyToCreate) {
                        newNode = flowUtil.createNode(this,node);
                        if (newNode) {
                            this.activeNodes[id] = newNode;
                        }
                    }
                } else {
                    this.debug("not starting disabled config node : "+id);
                }
            }
        }

        if (diff && diff.rewired) {
            for (var j=0;j<diff.rewired.length;j++) {
                var rewireNode = this.activeNodes[diff.rewired[j]];
                if (rewireNode) {
                    rewireNode.updateWires(this.flow.nodes[rewireNode.id].wires);
                }
            }
        }

        for (id in this.flow.nodes) {
            if (this.flow.nodes.hasOwnProperty(id)) {
                node = this.flow.nodes[id];
                if (node.d !== true) {
                    if (!node.subflow) {
                        if (!this.activeNodes[id]) {
                            newNode = flowUtil.createNode(this,node);
                            if (newNode) {
                                this.activeNodes[id] = newNode;
                            }
                        }
                    } else {
                        if (!this.subflowInstanceNodes[id]) {
                            try {
                                var subflowDefinition = this.flow.subflows[node.subflow]||this.global.subflows[node.subflow]
                                // console.log("NEED TO CREATE A SUBFLOW",id,node.subflow);
                                this.subflowInstanceNodes[id] = true;
                                var subflow = Subflow.create(
                                    this,
                                    this.global,
                                    subflowDefinition,
                                    node
                                );
                                this.subflowInstanceNodes[id] = subflow;
                                subflow.start();
                                this.activeNodes[id] = subflow.node;

                                // this.subflowInstanceNodes[id] = nodes.map(function(n) { return n.id});
                                // for (var i=0;i<nodes.length;i++) {
                                //     if (nodes[i]) {
                                //         this.activeNodes[nodes[i].id] = nodes[i];
                                //     }
                                // }
                            } catch(err) {
                                console.log(err.stack)
                            }
                        }
                    }
                } else {
                    this.debug("not starting disabled node : "+id);
                }
            }
        }

        var activeCount = Object.keys(this.activeNodes).length;
        if (activeCount > 0) {
            this.trace("------------------|--------------|-----------------");
            this.trace(" id               | type         | alias");
            this.trace("------------------|--------------|-----------------");
        }
        // Build the map of catch/status/complete nodes.
        for (id in this.activeNodes) {
            if (this.activeNodes.hasOwnProperty(id)) {
                node = this.activeNodes[id];
                this.trace(" "+id.padEnd(16)+" | "+node.type.padEnd(12)+" | "+(node._alias||"")+(node._zAlias?" [zAlias:"+node._zAlias+"]":""));
                if (node.type === "catch") {
                    this.catchNodes.push(node);
                } else if (node.type === "status") {
                    this.statusNodes.push(node);
                } else if (node.type === "complete") {
                    if (node.scope) {
                        node.scope.forEach(id => {
                            this.completeNodeMap[id] = this.completeNodeMap[id] || [];
                            this.completeNodeMap[id].push(node);
                        })
                    }
                }
            }
        }
        this.catchNodes.sort(function(A,B) {
            if (A.scope && !B.scope) {
                return -1;
            } else if (!A.scope && B.scope) {
                return 1;
            } else if (A.scope && B.scope) {
                return 0;
            } else if (A.uncaught && !B.uncaught) {
                return 1;
            } else if (!A.uncaught && B.uncaught) {
                return -1;
            }
            return 0;
        });

        if (activeCount > 0) {
            this.trace("------------------|--------------|-----------------");
        }
        // this.dump();
    }

    /**
     * Stop this flow.
     * The `stopList` argument helps define what needs to be stopped in the case
     * of a modified-nodes/flows type deploy.
     * @param  {[type]} stopList    [description]
     * @param  {[type]} removedList [description]
     * @return {[type]}             [description]
     */
    stop(stopList, removedList) {
        this.trace("stop "+this.TYPE);
        var i;
        if (!stopList) {
            stopList = Object.keys(this.activeNodes);
        }
        // this.trace(" stopList: "+stopList.join(","))
        // Convert the list to a map to avoid multiple scans of the list
        var removedMap = {};
        removedList = removedList || [];
        removedList.forEach(function(id) {
            removedMap[id] = true;
        });

        let nodesToStop = [];
        let configsToStop = [];
        stopList.forEach(id => {
            if (this.flow.configs[id]) {
                configsToStop.push(id);
            } else {
                nodesToStop.push(id);
            }
        });
        stopList = nodesToStop.concat(configsToStop);

        var promises = [];
        for (i=0;i<stopList.length;i++) {
            var node = this.activeNodes[stopList[i]];
            if (node) {
                delete this.activeNodes[stopList[i]];
                if (this.subflowInstanceNodes[stopList[i]]) {
                    delete this.subflowInstanceNodes[stopList[i]];
                }
                try {
                    var removed = removedMap[stopList[i]];
                    promises.push(stopNode(node,removed).catch(()=>{}));
                } catch(err) {
                    node.error(err);
                }
                if (removedMap[stopList[i]]) {
                    events.emit("node-status",{
                        id: node.id
                    });
                }
            }
        }
        return Promise.all(promises);
    }

    /**
     * Update the flow definition. This doesn't change anything that is running.
     * This should be called after `stop` and before `start`.
     * @param  {[type]} _global [description]
     * @param  {[type]} _flow   [description]
     * @return {[type]}         [description]
     */
    update(_global,_flow) {
        this.global = _global;
        this.flow = _flow;
    }

    /**
     * Get a node instance from this flow. If the node is not known to this
     * flow, pass the request up to the parent.
     * @param  {String} id [description]
     * @param  {Boolean} cancelBubble    if true, prevents the flow from passing the request to the parent
     *                                   This stops infinite loops when the parent asked this Flow for the
     *                                   node to begin with.
     * @return {[type]}    [description]
     */
    getNode(id, cancelBubble) {
        if (!id) {
            return undefined;
        }
        // console.log((new Error().stack).toString().split("\n").slice(1,3).join("\n"))
        if ((this.flow.configs && this.flow.configs[id]) || (this.flow.nodes && this.flow.nodes[id] && this.flow.nodes[id].type.substring(0,8) != "subflow:")) {
            // This is a node owned by this flow, so return whatever we have got
            // During a stop/restart, activeNodes could be null for this id
            return this.activeNodes[id];
        } else if (this.activeNodes[id]) {
            // TEMP: this is a subflow internal node within this flow or subflow instance node
            return this.activeNodes[id];
        } else if (this.subflowInstanceNodes[id]) {
            return this.subflowInstanceNodes[id];
        } else if (cancelBubble) {
            // The node could be inside one of this flow's subflows
            var node;
            for (var sfId in this.subflowInstanceNodes) {
                if (this.subflowInstanceNodes.hasOwnProperty(sfId)) {
                    node = this.subflowInstanceNodes[sfId].getNode(id,cancelBubble);
                    if (node) {
                        return node;
                    }
                }
            }
        } else {
            // Node not found inside this flow - ask the parent
            return this.parent.getNode(id);
        }
        return undefined;
    }


    /**
     * Get a group node instance
     * @param  {String} id
     * @return {Node}   group node
     */
    getGroupNode(id) {
        const groups = this.global.groups;
        return groups[id];
    }

    /**
     * Get all of the nodes instantiated within this flow
     * @return {[type]} [description]
     */
    getActiveNodes() {
        return this.activeNodes;
    }

    /*!
     * Get value of environment variable defined in group node.
     * @param {String} group - group node
     * @param {String} name - name of variable
     * @return {Object} object containing the value in val property or null if not defined
     */
    getGroupEnvSetting(node, group, name) {
        if (group) {
            if (name === "NR_GROUP_NAME") {
                return [{
                    val: group.name
                }, null];
            }
            if (name === "NR_GROUP_ID") {
                return [{
                    val: group.id
                }, null];
            }

            if (group.credentials === undefined) {
                group.credentials = credentials.get(group.id) || {};
            }
            if (!name.startsWith("$parent.")) {
                if (group.env) {
                    if (!group._env) {
                        const envs = group.env;
                        const entries = envs.map((env) => {
                            if (env.type === "cred") {
                                const cred = group.credentials;
                                if (cred.hasOwnProperty(env.name)) {
                                    env.value = cred[env.name];
                                }
                            }
                            return [env.name, env];
                        });
                        group._env = Object.fromEntries(entries);
                    }
                    const env = group._env[name];
                    if (env) {
                        let value = env.value;
                        const type = env.type;
                        if ((type !== "env") ||
                            (value !== name)) {
                            if (type === "env") {
                                value = value.replace(new RegExp("\\${"+name+"}","g"),"${$parent."+name+"}");
                            }
                            if (type === "bool") {
                                const val
                                      = ((value === "true") ||
                                         (value === true));
                                return [{
                                    val: val
                                }, null];
                            }
                            if (type === "cred") {
                                return [{
                                    val: value
                                }, null];
                            }
                            try {
                                var val = redUtil.evaluateNodeProperty(value, type, node, null, null);
                                return [{
                                    val: val
                                }, null];
                            }
                            catch (e) {
                                this.error(e);
                                return [null, null];
                            }
                        }
                    }
                }
            }
            else {
                name = name.substring(8);
            }
            if (group.g) {
                const parent = this.getGroupNode(group.g);
                return this.getGroupEnvSetting(node, parent, name);
            }
        }
        return [null, name];
    }


    /**
     * Get a flow setting value. This currently automatically defers to the parent
     * flow which, as defined in ./index.js returns `process.env[key]`.
     * This lays the groundwork for Subflow to have instance-specific settings
     * @param  {[type]} key [description]
     * @return {[type]}     [description]
     */
    getSetting(key) {
        const flow = this.flow;
        if (key === "NR_FLOW_NAME") {
            return flow.label;
        }
        if (key === "NR_FLOW_ID") {
            return flow.id;
        }
        if (flow.credentials === undefined) {
            flow.credentials = credentials.get(flow.id) || {};
        }
        if (flow.env) {
            if (!key.startsWith("$parent.")) {
                if (!flow._env) {
                    const envs = flow.env;
                    const entries = envs.map((env) => {
                        if (env.type === "cred") {
                            const cred = flow.credentials;
                            if (cred.hasOwnProperty(env.name)) {
                                env.value = cred[env.name];
                            }
                        }
                        return [env.name, env]
                    });
                    flow._env = Object.fromEntries(entries);
                }
                const env = flow._env[key];
                if (env) {
                    let value = env.value;
                    const type = env.type;
                    if ((type !== "env") || (value !== key)) {
                        if (type === "env") {
                            value = value.replace(new RegExp("\\${"+key+"}","g"),"${$parent."+key+"}");
                        }
                        try {
                            if (type === "bool") {
                                const val = ((value === "true") ||
                                             (value === true));
                                return val;
                            }
                            if (type === "cred") {
                                return value;
                            }
                            var val = redUtil.evaluateNodeProperty(value, type, null, null, null);
                            return val;
                        }
                        catch (e) {
                            this.error(e);
                        }
                    }
                }
            }
            else {
                key = key.substring(8);
            }
        }
        return this.parent.getSetting(key);
    }

    /**
     * Handle a status event from a node within this flow.
     * @param  {Node}    node            The original node that triggered the event
     * @param  {Object}  statusMessage   The status object
     * @param  {Node}    reportingNode   The node emitting the status event.
     *                                   This could be a subflow instance node when the status
     *                                   is being delegated up.
     * @param  {boolean} muteStatusEvent Whether to emit the status event
     * @return {[type]}                  [description]
     */
    handleStatus(node,statusMessage,reportingNode,muteStatusEvent) {
        if (!reportingNode) {
            reportingNode = node;
        }
        if (!muteStatusEvent) {
            if (statusMessage.hasOwnProperty("text") && typeof statusMessage.text !== "string") {
                try {
                    statusMessage.text = statusMessage.text.toString();
                }
                catch(e) {}
            }
            events.emit("node-status",{
                id: node.id,
                status:statusMessage
            });
        }

        let handled = false;

        if (this.id === 'global' && node.users) {
            // This is a global config node
            // Delegate status to any nodes using this config node
            for (let userNode in node.users) {
                if (node.users.hasOwnProperty(userNode)) {
                    node.users[userNode]._flow.handleStatus(node,statusMessage,node.users[userNode],true);
                }
            }
            handled = true;
        } else {
            this.statusNodes.forEach(function(targetStatusNode) {
                if (targetStatusNode.scope && targetStatusNode.scope.indexOf(reportingNode.id) === -1) {
                    return;
                }
                var message = {
                    status: clone(statusMessage)
                }
                if (statusMessage.hasOwnProperty("text")) {
                    message.status.text = statusMessage.text.toString();
                }
                message.status.source = {
                    id: node.id,
                    type: node.type,
                    name: node.name
                }

                targetStatusNode.receive(message);
                handled = true;
            });
        }
        return handled;
    }

    /**
     * Handle an error event from a node within this flow. If there are no Catch
     * nodes within this flow, pass the event to the parent flow.
     * @param  {[type]} node          [description]
     * @param  {[type]} logMessage    [description]
     * @param  {[type]} msg           [description]
     * @param  {[type]} reportingNode [description]
     * @return {[type]}               [description]
     */
    handleError(node,logMessage,msg,reportingNode) {
        if (!reportingNode) {
            reportingNode = node;
        }
        // console.log("HE",logMessage);
        var count = 1;
        if (msg && msg.hasOwnProperty("error") && msg.error) {
            if (msg.error.hasOwnProperty("source") && msg.error.source) {
                if (msg.error.source.id === node.id) {
                    count = msg.error.source.count+1;
                    if (count === 10) {
                        node.warn(Log._("nodes.flow.error-loop"));
                        return false;
                    }
                }
            }
        }
        let handled = false;

        if (this.id === 'global' && node.users) {
            // This is a global config node
            // Delegate status to any nodes using this config node
            for (let userNode in node.users) {
                if (node.users.hasOwnProperty(userNode)) {
                    node.users[userNode]._flow.handleError(node,logMessage,msg,node.users[userNode]);
                }
            }
            handled = true;
        } else {
            var handledByUncaught = false;

            this.catchNodes.forEach(function(targetCatchNode) {
                if (targetCatchNode.scope && targetCatchNode.scope.indexOf(reportingNode.id) === -1) {
                    return;
                }
                if (!targetCatchNode.scope && targetCatchNode.uncaught && !handledByUncaught) {
                    if (handled) {
                        // This has been handled by a !uncaught catch node
                        return;
                    }
                    // This is an uncaught error
                    handledByUncaught = true;
                }
                var errorMessage;
                if (msg) {
                    errorMessage = redUtil.cloneMessage(msg);
                } else {
                    errorMessage = {};
                }
                if (errorMessage.hasOwnProperty("error")) {
                    errorMessage._error = errorMessage.error;
                }
                errorMessage.error = {
                    message: logMessage.toString(),
                    source: {
                        id: node.id,
                        type: node.type,
                        name: node.name,
                        count: count
                    }
                };
                if (logMessage.hasOwnProperty('stack')) {
                    errorMessage.error.stack = logMessage.stack;
                }
                targetCatchNode.receive(errorMessage);
                handled = true;
            });
        }
        return handled;
    }

    handleComplete(node,msg) {
        if (this.completeNodeMap[node.id]) {
            let toSend = msg;
            this.completeNodeMap[node.id].forEach((completeNode,index) => {
                toSend = redUtil.cloneMessage(msg);
                completeNode.receive(toSend);
            })
        }
    }

    send(sendEvents) {
        // onSend - passed an array of SendEvent objects. The messages inside these objects are exactly what the node has passed to node.send - meaning there could be duplicate references to the same message object.
        // preRoute - called once for each SendEvent object in turn
        // preDeliver - the local router has identified the node it is going to send to. At this point, the message has been cloned if needed.
        // postDeliver - the message has been dispatched to be delivered asynchronously (unless the sync delivery flag is set, in which case it would be continue as synchronous delivery)
        // onReceive - a node is about to receive a message
        // postReceive - the message has been passed to the node's input handler
        // onDone, onError - the node has completed with a message or logged an error
        handleOnSend(this,sendEvents, (err, eventData) => {
            if (err) {
                let srcNode;
                if (Array.isArray(eventData)) {
                    srcNode = eventData[0].source.node;
                } else {
                    srcNode = eventData.source.node;
                }
                srcNode.error(err);
            }
        });
    }

    dump() {
        console.log("==================")
        console.log(this.TYPE, this.id);
        for (var id in this.activeNodes) {
            if (this.activeNodes.hasOwnProperty(id)) {
                var node = this.activeNodes[id];
                console.log(" ",id.padEnd(16),node.type)
                if (node.wires) {
                    console.log("   -> ",node.wires)
                }
            }
        }
        console.log("==================")
    }

}

/**
 * Stop an individual node within this flow.
 *
 * @param  {[type]} node    [description]
 * @param  {[type]} removed [description]
 * @return {[type]}         [description]
 */
function stopNode(node,removed) {
    Log.trace("Stopping node "+node.type+":"+node.id+(removed?" removed":""));
    const start = Date.now();
    const closePromise = node.close(removed);
    let closeTimer = null;
    const closeTimeout = new Promise((resolve,reject) => {
        closeTimer = setTimeout(() => {
            reject("Close timed out");
        }, nodeCloseTimeout);
    });
    return Promise.race([closePromise,closeTimeout]).then(() => {
        clearTimeout(closeTimer);
        var delta = Date.now() - start;
        Log.trace("Stopped node "+node.type+":"+node.id+" ("+delta+"ms)" );
    }).catch(err => {
        clearTimeout(closeTimer);
        node.error(Log._("nodes.flows.stopping-error",{message:err}));
        Log.debug(err.stack);
    })
}


function handleOnSend(flow,sendEvents, reportError) {
    // onSend - passed an array of SendEvent objects. The messages inside these objects are exactly what the node has passed to node.send - meaning there could be duplicate references to the same message object.
    hooks.trigger("onSend",sendEvents,(err) => {
        if (err) {
            reportError(err,sendEvents);
            return
        } else if (err !== false) {
            for (var i=0;i<sendEvents.length;i++) {
                handlePreRoute(flow,sendEvents[i],reportError)
            }
        }
    });
}

function handlePreRoute(flow, sendEvent, reportError) {
    // preRoute - called once for each SendEvent object in turn
    hooks.trigger("preRoute",sendEvent,(err) => {
        if (err) {
            reportError(err,sendEvent);
            return;
        } else if (err !== false) {
            sendEvent.destination.node = flow.getNode(sendEvent.destination.id);
            if (sendEvent.destination.node) {
                if (sendEvent.cloneMessage) {
                    sendEvent.msg = redUtil.cloneMessage(sendEvent.msg);
                }
                handlePreDeliver(flow,sendEvent,reportError);
            }
        }
    })
}

function handlePreDeliver(flow,sendEvent, reportError) {
    // preDeliver - the local router has identified the node it is going to send to. At this point, the message has been cloned if needed.
    hooks.trigger("preDeliver",sendEvent,(err) => {
        if (err) {
            reportError(err,sendEvent);
            return;
        } else if (err !== false) {
            if (asyncMessageDelivery) {
                setImmediate(function() {
                    if (sendEvent.destination.node) {
                        sendEvent.destination.node.receive(sendEvent.msg);
                    }
                })
            } else {
                if (sendEvent.destination.node) {
                    sendEvent.destination.node.receive(sendEvent.msg);

                }
            }
            // postDeliver - the message has been dispatched to be delivered asynchronously (unless the sync delivery flag is set, in which case it would be continue as synchronous delivery)
            hooks.trigger("postDeliver", sendEvent, function(err) {
                if (err) {
                    reportError(err,sendEvent);
                }
            })
        }
    })
}

module.exports = {
    init: function(runtime) {
        nodeCloseTimeout = runtime.settings.nodeCloseTimeout || 15000;
        asyncMessageDelivery = !runtime.settings.runtimeSyncDelivery
        Log = runtime.log;
        Subflow = require("./Subflow");
    },
    create: function(parent,global,conf) {
        return new Flow(parent,global,conf);
    },
    Flow: Flow
}
