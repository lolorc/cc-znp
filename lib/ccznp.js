/* jshint node: true */
'use strict';

var util = require('util'),
    EventEmitter = require('events').EventEmitter;

var Unpi = require('unpi'),
    Serialport = require('serialport'),
    debug = require('debug')('cc-znp'),
    logSreq = require('debug')('cc-znp:SREQ'),
    logSrsp = require('debug')('cc-znp:SRSP'),
    logAreq = require('debug')('cc-znp:AREQ');

var zmeta = require('./zmeta'),
    ZpiObject = require('./zpiObject')

var MT = {
    CMDTYPE: zmeta.CmdType,
    SUBSYS: zmeta.Subsys,
    SYS: zmeta.SYS,
    MAC: zmeta.MAC,
    AF: zmeta.AF,
    ZDO: zmeta.ZDO,
    SAPI: zmeta.SAPI,
    UTIL: zmeta.UTIL,
    DBG: zmeta.DBG,
    APP: zmeta.APP
};

/*************************************************************************************************/
/*** Polyfill                                                                                  ***/
/*************************************************************************************************/
if (!EventEmitter.prototype.listenerCount ) {
  EventEmitter.prototype.listenerCount = function (type){
    var events = this._events;

    if (events) {
      var evlistener = events[type];

      if (typeof evlistener === 'function') {
        return 1;
      } else if (evlistener) {
        return evlistener.length;
      }
    }

    return 0;
  };
}

/*************************************************************************************************/
/*** CcZnp Class                                                                               ***/
/*************************************************************************************************/
function CcZnp () {
    EventEmitter.call(this);

    var self = this;

    this.MT = MT;       // export constant

    this._init = false;
    this._resetting = false;
    this._sp = null;
    this._unpi = null;
    this._spinLock = false;
    this._txQueue = [];
    this._backlog = [];

    this.on('_ready', function () {
        self._init = true;
        self.emit('ready');
    });

    this.on("SRSP:RES0:error", function(data){
        // data: {status, typesubsys, cmd}
        try {
            const subsys = data.typesubsys & 0xF 
            var argObj = new ZpiObject(subsys, data.cmd);
            var srspEvt = 'SRSP:' + argObj.subsys + ':' + argObj.cmd
            if (self.listenerCount(srspEvt))
                self.emit(srspEvt, '__error__');
        }catch(ex){
            debug("Unable to understand MT error message, err: %s", ex)
        }
    });

    var closeCbs = []
    this._close = function(callback){
        if(!self._sp || !self._sp.isOpen){
            return callback(null)
        }
        callback = callback || function(){}
        closeCbs.push(callback)
        if(closeCbs.length == 1){
            self._sp.close(function(arg){
                for(var i=0;i<closeCbs.length;i++){
                    closeCbs[i](arg)
                }
                closeCbs = []
            });
        }
    }

    this._innerListeners = {
        spOpen: function () {
            debug('The serialport ' + self._sp.path + ' is opened.');
            self.emit('_ready');
        },
        spErr: function (err) {
            debug("An error occured with the serialport: " + err.toString())
            if(self._sp.isOpen && !self._sp._errClosing) {
                self._sp._errClosing = true
                self._close()
            }
        },
        spClose: function () {
            debug('The serialport ' + self._sp.path + ' is closed.');
            self._txQueue = null;
            self._txQueue = [];
            self._sp = null;
            self._unpi = null;
            self._init = false;
            self.emit('close');
        },
        parseMtIncomingData: function (result) {
            self._parseMtIncomingData(result);
        }
    };
}

function valObjFormat(valObj){
    var ret = undefined
    if(valObj.dstaddr){
        ret = ret?ret:Object.assign({}, valObj)
        ret.dstaddr = "0x"+parseInt(valObj.dstaddr).toString(16)
    }
    if(valObj.srcaddr){
        ret = ret?ret:Object.assign({}, valObj)
        ret.srcaddr = "0x"+parseInt(valObj.srcaddr).toString(16)
    }
    if(valObj.nwkaddr){
        ret = ret?ret:Object.assign({}, valObj)
        ret.nwkaddr = "0x"+parseInt(valObj.nwkaddr).toString(16)
    }
    if(valObj.nwkaddrofinterest){
        ret = ret?ret:Object.assign({}, valObj)
        ret.nwkaddrofinterest = "0x"+parseInt(valObj.nwkaddrofinterest).toString(16)
    }
    return ret ? ret : valObj
}

util.inherits(CcZnp, EventEmitter);

/*************************************************************************************************/
/*** Public APIs                                                                               ***/
/*************************************************************************************************/
CcZnp.prototype.init = function (spCfg, callback) {
    if (typeof spCfg !== 'object' || Array.isArray(spCfg))
        throw new TypeError('spCfg should be a plain object.');

    if (!spCfg.options)
        spCfg.options = { autoOpen: false };
    else
        spCfg.options.autoOpen = false;

    callback = callback || function () {};

    var sp = this._sp = (this._sp instanceof Serialport) ? this._sp : new Serialport(spCfg.path, spCfg.options),
        unpi = this._unpi = (this._unpi instanceof Unpi) ? this._unpi : new Unpi({ lenBytes: 1, phy: sp });

    // Listeners for inner use
    var parseMtIncomingData = this._innerListeners.parseMtIncomingData,
        spOpenLsn = this._innerListeners.spOpen,
        spErrLsn = this._innerListeners.spErr,
        spCloseLsn = this._innerListeners.spClose;

    if (!sp)
        throw new Error('Cannot initialize serial port.');

    if (!unpi)
        throw new Error('Cannot initialize unpi.');

    // remove all inner listeners were attached on last init
    unpi.removeListener('data', parseMtIncomingData);
    sp.removeListener('open', spOpenLsn);
    sp.removeListener('error', spErrLsn);
    sp.removeListener('close', spCloseLsn);

    // re-attach inner listeners
    unpi.on('data', parseMtIncomingData);
    sp.once('open', spOpenLsn);

    sp.open(function (err) {
        if (err)
            return callback(err);

        sp.on('error', spErrLsn);
        sp.on('close', spCloseLsn);
        callback(null);
    });
};

CcZnp.prototype.close = function (callback) {
    var self = this;

    if (this._init) {
        this._sp.flush(function () {
            self._close(callback)
        });
    } else {
        callback(null);
    }
};

CcZnp.prototype.request = function (subsys, cmd, valObj, callback) {
    // subsys: String | Number, cmd: String | Number, valObj: Object | Array
    var self = this,
        argObj;

    if (!this._init)
        throw new Error('ccznp has not been initialized yet');

    // validations
    if (!valObj || typeof valObj !== 'object') 
        throw new TypeError('valObj should be an object');
    else if ((typeof callback !== 'function') && (typeof callback !== 'undefined'))
        throw new TypeError('callback should be a function');
    else 
        argObj = new ZpiObject(subsys, cmd, valObj);

    // prepare for transmission with spinlock
    if (this._spinLock) {
        var entry = {
            subsys: subsys,
            cmd: cmd,
            fn: function () {
                try {
                    self.request(subsys, cmd, valObj, callback);
                }catch(ex){
                    /* Exception of not yet initialized */
                    callback(ex)
                }
            }
        }
        this._txQueue.push(entry);
        return
    }
    this._spinLock = true;

    if (argObj.type === 'SREQ') {
        logSreq('--> %s:%s, %o', argObj.subsys, argObj.cmd, valObjFormat(valObj));
        return this._sendSREQ(argObj, valObj, callback);
    } else if (argObj.type === 'AREQ') {
        logAreq('--> %s:%s, %o', argObj.subsys, argObj.cmd, valObjFormat(valObj));
        return this._sendAREQ(argObj, callback);
    }
};

CcZnp.prototype.sendCmd = function (type, subsys, cmdId, payload) {
    return this._unpi.send(type, subsys, cmdId, payload);
};

/*********************************/
/*** Create Request Shorthands ***/
/*********************************/
// example: ccznp.sysRequest(), ccznp.zdoRequest()
var namespaces = [ 'RES0', 'SYS', 'MAC', 'NWK', 'AF', 'ZDO', 'SAPI', 'UTIL', 'DBG', 'APP' ];

namespaces.forEach(function (subsys) {
    var reqMethod = subsys.toLowerCase() + 'Request';
    CcZnp.prototype[reqMethod] = function (cmdId, valObj, callback) {
        return this.request(subsys, cmdId, valObj, callback);
    };
});

/*************************************************************************************************/
/*** Protected Methods                                                                         ***/
/*************************************************************************************************/

CcZnp.prototype._sendSREQ = function (argObj, valObj, callback) {
    // subsys: String, cmd: String
    var self = this,
        payload = argObj.frame(),
        sreqTimeout, sreqNextQueue,
        srspEvt = 'SRSP:' + argObj.subsys + ':' + argObj.cmd,
        backlog = new Array(self._backlog),
        ownEvent

    if (!payload) {
        callback(new Error('Fail to build frame'));
        return;
    }

    /* longest operation is NVRAM write at ~700ms */
    sreqTimeout = setTimeout(function () {
        if (self.listenerCount(srspEvt))
            self.emit(srspEvt, '__timeout__');

        sreqTimeout = null;
    }, 3500);
    sreqNextQueue = setTimeout(function () {
        //create backlog entry
        ownEvent = {
            evt: srspEvt,
            subsys: argObj.subsys,
            cmd: argObj.cmd
        }
        self._backlog.push(ownEvent)

        sreqNextQueue = null;

        // schedule next transmission if something is in txQueue
        // if we are still waiting this will be buffered and as a result
        // it will get less time to execute, but this is unlikely
        if(self._scheduleNextSend(true)){
            self._spinLock = false;
        }
    }, 1800);

    // attach response listener
    this.once(srspEvt, function (result) {
        var hasSent = true
        if(self._spinLock){
            self._spinLock = false
            hasSent = false
        }
        
        // clear timeout controller if it is there
        if (sreqTimeout) {
            clearTimeout(sreqTimeout);
            sreqTimeout = null;
        }

        // Send timeouts to any past events in the next event loop as
        // This works because SREQ's are syncronous and processor is single threaded
        setImmediate(function(){
            backlog.forEach(function(backlogEntry){
                var pos = self._backlog.indexOf(backlogEntry)
                if(pos != -1) {
                    if (self.listenerCount(backlogEntry.evt)){
                        self.emit(backlogEntry.evt, '__timeout__');
                    }
                    self._backlog.splice(pos, 1)
                }
            })
        })
        if(ownEvent){
            var pos = self._backlog.indexOf(ownEvent)
            if(pos != -1) self._backlog.splice(pos, 1)
        }

        // schedule next transmission if something in txQueue
        if(sreqNextQueue){
            clearTimeout(sreqNextQueue);
            sreqNextQueue = null;
        }

        if(!hasSent){
            self._scheduleNextSend();
        }

        // check if this event is fired by timeout controller
        if (result === '__timeout__') {
            logSrsp('<-- %s:%s, TIMEOUT, %o', argObj.subsys, argObj.cmd, valObjFormat(valObj));
            callback(new Error('request timeout'));
        } else if (result === '__error__') {
            logSrsp('<-- %s:%s, ERROR, %o', argObj.subsys, argObj.cmd, valObjFormat(valObj));
            callback(new Error('request communication error'));
        } else {
            self._resetting = false;
            callback(null, result);
        }
    });

    this._unpi.send('SREQ', argObj.subsys, argObj.cmdId, payload);
};

CcZnp.prototype._sendAREQ = function (argObj, callback) {
    // subsys: String, cmd: String
    var self = this,
        payload = argObj.frame();

    if (!payload) {
        callback(new Error('Fail to build frame'));
        return;
    }

    if (argObj.cmd === 'resetReq' || argObj.cmd === 'systemReset') {
        this._resetting = true;
        // clear all pending requests, since the system is reset
        this._txQueue = null;
        this._txQueue = [];

        this.once('AREQ:SYS:RESET', function () {
            // hold the lock until coordinator reset completed
            self._resetting = false;
            self._spinLock = false;
            callback(null);
        });

        // if AREQ:SYS:RESET does not return in 30 sec
        // release the lock to avoid the requests from enqueuing
        setTimeout(function () {
            if (self._resetting)
                self._spinLock = false;
        }, 30000);

    } else {
        this._spinLock = false;
        this._scheduleNextSend();
        callback(null);
    }

    this._unpi.send('AREQ', argObj.subsys, argObj.cmdId, payload);
};

CcZnp.prototype._scheduleNextSend = function (early) {
    var txQueue = this._txQueue;

    if (txQueue.length) {
        var entry
        if(early){
            var self = this
            var entryIndex = txQueue.findIndex(function(entry){
                for(var i in self._backlog){
                    var b = self._backlog[i]
                    if(b.subsys == entry.subsys && b.cmd == entry.cmd){
                        return false
                    }
                }
                return true
            });
            if(entryIndex === -1) return false
            entry = txQueue[entryIndex]
            txQueue.splice(entryIndex, 1)
        }else{
            entry = txQueue.shift()
        }

        if(entry){
            setImmediate(function txDeQueue() {
                entry.fn();
            });
            return true
        }
    }
    return false
};

CcZnp.prototype._parseMtIncomingData = function (data) {
    // data = { sof, len, type, subsys, cmd, payload, fcs, csum }
    var self = this,
        argObj;

    this.emit('data', data);

    try {
        if (data.fcs !== data.csum)
            throw new Error('Invalid checksum');

        argObj = new ZpiObject(data.subsys, data.cmd);
        data.type = zmeta.CmdType.get(data.type).key;    // make sure data.type will be string
        data.subsys = argObj.subsys;                     // make sure data.subsys will be string
        data.cmd = argObj.cmd;                           // make sure data.cmd will be string

        argObj.parse(data.type, data.len, data.payload, function (err, result) {
            data.payload = result;

            self._mtIncomingDataHdlr(err, data);
        });
    } catch (e) {
        this._mtIncomingDataHdlr(e, data);
    }
};

CcZnp.prototype._mtIncomingDataHdlr = function (err, data) {
    // data = { sof, len, type, subsys, cmd, payload = result, fcs, csum }
    if (err) {
        debug(err); // just print out. do nothing if incoming data is invalid
        return;
    }

    var rxEvt,
        msg,
        listeners,
        subsys = data.subsys,
        cmd = data.cmd,
        result = data.payload;

    if (data.type === 'SRSP') {
        rxEvt = 'SRSP:' + subsys + ':' + cmd;
        listeners = this.listenerCount(rxEvt)
        logSrsp('<-- %s:%s, %o%s', subsys, cmd, valObjFormat(result), listeners ? "":" (NO LISTENERS)");
        if (listeners)
            this.emit(rxEvt, result);
    } else if (data.type === 'AREQ') {
        logAreq('<-- %s:%s, %o', subsys, cmd, valObjFormat(result));
        rxEvt = 'AREQ';
        msg = {
            subsys: subsys,
            ind: cmd,
            data: result
        };

        this.emit(rxEvt, msg);

        if (subsys === 'SYS' && cmd === 'resetInd') {
            rxEvt = 'AREQ:SYS:RESET';
            this.emit(rxEvt, result);
        }
    }
};

module.exports = CcZnp;