/**
...

- can no longer create a sentinel client thru redis.createClient({sentinel:true})
- @todo copy failover test from gist
*/

var RedisSingleClient = require('redis'),
    events = require('events'),
    util = require('util'),
    reply_to_object = require('redis/lib/util.js').reply_to_object,
    to_array = require('redis/lib/to_array.js'),
    commands;


// @todo submit PR to node_redis to export this.
//// i.e. commands = RedisSingleClient.commands;
// for now, duplicates redis/index.js

// - also need this
// take 2 arrays and return the union of their elements
function set_union(seta, setb) {
    var obj = {};
    seta.forEach(function (val) {
        obj[val] = true;
    });
    setb.forEach(function (val) {
        obj[val] = true;
    });
    return Object.keys(obj);
}

commands = set_union(["get", "set", "setnx", "setex", "append", "strlen", "del", "exists", "setbit", "getbit", "setrange", "getrange", "substr",
    "incr", "decr", "mget", "rpush", "lpush", "rpushx", "lpushx", "linsert", "rpop", "lpop", "brpop", "brpoplpush", "blpop", "llen", "lindex",
    "lset", "lrange", "ltrim", "lrem", "rpoplpush", "sadd", "srem", "smove", "sismember", "scard", "spop", "srandmember", "sinter", "sinterstore",
    "sunion", "sunionstore", "sdiff", "sdiffstore", "smembers", "zadd", "zincrby", "zrem", "zremrangebyscore", "zremrangebyrank", "zunionstore",
    "zinterstore", "zrange", "zrangebyscore", "zrevrangebyscore", "zcount", "zrevrange", "zcard", "zscore", "zrank", "zrevrank", "hset", "hsetnx",
    "hget", "hmset", "hmget", "hincrby", "hdel", "hlen", "hkeys", "hvals", "hgetall", "hexists", "incrby", "decrby", "getset", "mset", "msetnx",
    "randomkey", "select", "move", "rename", "renamenx", "expire", "expireat", "keys", "dbsize", "auth", "ping", "echo", "save", "bgsave",
    "bgrewriteaof", "shutdown", "lastsave", "type", "multi", "exec", "discard", "sync", "flushdb", "flushall", "sort", "info", "monitor", "ttl",
    "persist", "slaveof", "debug", "config", "subscribe", "unsubscribe", "psubscribe", "punsubscribe", "publish", "watch", "unwatch", "cluster",
    "restore", "migrate", "dump", "object", "client", "eval", "evalsha"], require("redis/lib/commands.js"));


/*
options includes:
- host
- port
- masterName
- logger (e.g. winston)
- debug (boolean)
*/
function RedisSentinelClient(options) {
  // make this an EventEmitter (also below)
  events.EventEmitter.call(this);

  var self = this;

  this.options = options = options || {};

  this.options.masterName = this.options.masterName || 'mymaster';

  // no socket support for now (b/c need multiple connections).
  if (options.port == null || options.host == null) {
    throw new Error("Sentinel client needs a host and port");
  }

  // RedisClient takes (stream,options). we don't want stream, make sure only one.
  if (arguments.length > 1) {
    throw new Error("Sentinel client takes only options to initialize");
  }

  // this client will always be connected to the active master.
  // exposed publicly.
  // (initialized on reconnect())
  this.activeMasterClient = null;

  // used for swaps
  this.oldMasterClient = null;

  // used for logging & errors
  this.myName = 'sentinel-' + this.options.host + ':' + this.options.port + '-' + this.options.masterName;


  /*
  what a failover looks like:
  - master fires ECONNREFUSED errors a few times
  - sentinel listener gets:
    +sdown
    +odown
    +failover-triggered
    +failover-state-wait-start
    +failover-state-select-slave
    +selected-slave
    +failover-state-send-slaveof-noone
    +failover-state-wait-promotion
    +promoted-slave
    +failover-state-reconf-slaves
    +slave-reconf-sent
    +slave-reconf-inprog
    +slave-reconf-done
    +failover-end
    +switch-master

  (see docs @ http://redis.io/topics/sentinel)

  note, these messages don't specify WHICH master is down.
  so if a sentinel is listening to multiple masters, and we have a RedisSentinelClient
  for each sentinel:master relationship, every client will be notified of every master's failovers.
  But that's fine, b/c reconnect() checks if it actually changed, and does nothing if not.
  */

  // one client to query ('talker'), one client to subscribe ('listener').
  // these are standard redis clients.
  // talker is used by reconnect() below
  this.sentinelTalker = new RedisSingleClient.createClient(options.port, options.host, { sentinel: false });
  this.sentinelTalker.on('connect', function(){
    self.debug('connected to sentinel talker');
  });
  this.sentinelTalker.on('error', function(error){
    error.message = self.myName + " talker error: " + error.message;
    self.onError.call(self, error);
  });
  this.sentinelTalker.on('end', function(){
    self.debug('sentinel talker disconnected');
    // @todo emit something?
    // @todo does it automatically reconnect? (supposed to)
  });

  var sentinelListener = new RedisSingleClient.createClient(options.port, options.host, { sentinel: false });
  sentinelListener.on('connect', function(){
    self.debug('connected to sentinel listener');
  });
  sentinelListener.on('error', function(error){
    error.message = self.myName + " listener error: " + error.message;
    self.onError(error);
  });
  sentinelListener.on('end', function(){
    self.debug('sentinel listener disconnected');
    // @todo emit something?
  });

  // Connect on load
  this.reconnect();

  // Subscribe to all messages
  sentinelListener.psubscribe('*');

  sentinelListener.on('pmessage', function(channel, msg) {
    self.debug('sentinel message', msg);

    // pass up, in case app wants to respond
    self.emit('sentinel message', msg);

    switch(msg) {
      case '+failover-triggered':
        self.debug('Failover detected');
        self.emit('failover-start');
        break;

      case '+failover-end':
        self.debug('Reconnect triggered by ' + msg);
        self.emit('failover-end');
        self.reconnect();
        break;
    }
  });

}

util.inherits(RedisSentinelClient, events.EventEmitter);


// [re]connect activeMasterClient to the master.
// destroys the previous connection and replaces w/ a new one,
// (transparently to the user)
// but only if host+port have changed.
RedisSentinelClient.prototype.reconnect = function reconnect(onReconnectCallback) {
  var self = this;
  self.debug('reconnecting');

  self.sentinelTalker.send_command("SENTINEL", ["get-master-addr-by-name", self.options.masterName], function(error, newMaster) {
    if (error) {
      error.message = self.myName + " Error getting master: " + error.message;
      self.onError(error);
      return;
    }
    try {
      newMaster = {
        host: newMaster[0],
        port: newMaster[1]
      };
      self.debug('new master info', newMaster);
      if (!newMaster.host || !newMaster.port) throw new Error("Missing host or port");
    }
    catch(error) {
      error.message = self.myName + ' Unable to reconnect master: ' + error.message;
      self.onError(error);
    }

    if (self.activeMasterClient &&
        newMaster.host === self.activeMasterClient.host &&
        newMaster.port === self.activeMasterClient.port) {
      self.debug('Master has not changed, nothing to do');
      if (typeof onReconnectCallback === 'function') onReconnectCallback();
      return;
    }

    self.debug("Changing master from " +
      (self.activeMasterClient ? self.activeMasterClient.host + ":" + self.activeMasterClient.port : "[none]") +
      " to " + newMaster.host + ":" + newMaster.port);

    // "Note that this does not wait until all replies have been parsed.
    //  If you want to exit cleanly, call client.quit()"
    // @review

    // we don't want to queue commands. so push aside the old one, kill it on the side,
    // and simultaneously swap in a new one.
    // @review does this work?
    self.oldMasterClient = self.activeMasterClient;

    // note, old client will be null on 1st connect
    if (self.oldMasterClient) {
      self.debug('old master was on ' + self.oldMasterClient.host + ':' + self.oldMasterClient.port);

      // @check if this fn ends before end is called, will event still fire?
      self.oldMasterClient.once('end', function(){
        self.debug("Old master ended");
        self.emit('disconnected');
      });
    }

    // new master client
    // should queue all subsequent commands internally.
    // but any commands still queued in the old master, will be lost.
    self.activeMasterClient = new RedisSingleClient.createClient(newMaster.port, newMaster.host, { sentinel: false });

    // kill the old one
    if (self.oldMasterClient) {
      self.oldMasterClient.end();
    }

    // pass up errors, (& other events?)
    // @todo emit a separate 'master error' event?
    self.activeMasterClient.on('error', function(error){
      error.message = self.myName + " master error: " + error.message;
      self.onError.call(self, error);
    });

    // @todo use no_ready_check = true? then change this 'ready' to 'connect'

    // backwards-compat. w/RedisClient
    self.activeMasterClient.once('connect', function(){
      self.emit('connect');
    });

    self.activeMasterClient.once('ready', function(){
      self.debug('New master is ready');
      // anything outside holding a ref to activeMasterClient needs to listen to this,
      // and refresh its reference. pass the new master so it's easier.
      self.emit('reconnected', self.activeMasterClient);

      // backwards-compat. w/RedisClient
      self.emit('ready');

      if (typeof onReconnectCallback === 'function') onReconnectCallback();
    });

  });
};


//
// pass thru all client commands from RedisSentinelClient to activeMasterClient
//
RedisSentinelClient.prototype.send_command = function (command, args, callback) {
  // this ref needs to be totally atomic
  var client = this.activeMasterClient;
  return client.send_command.apply(client, arguments);
};

// adapted from index.js for RedisClient
commands.forEach(function (command) {
  RedisSentinelClient.prototype[command.toUpperCase()] =
  RedisSentinelClient.prototype[command] = function (args, callback) {
    var sentinel = this;

    sentinel.debug('command', command, args);

    if (Array.isArray(args) && typeof callback === "function") {
      return sentinel.send_command(command, args, callback);
    } else {
      return sentinel.send_command(command, to_array(arguments));
    }
  };
});

// automagically handle multi & exec?
// (tests will tell...)

// this multi is on the master client, so don't hold onto it too long!
var Multi = RedisSingleClient.Multi;

// @todo make a SentinelMulti that queues within the sentinel client?
//  would need to handle all Multi.prototype methods, etc.
//  for now let multi's queue die if the master dies.

RedisSentinelClient.prototype.multi =
RedisSentinelClient.prototype.MULTI = function (args) {
  return new Multi(this.activeMasterClient, args);
};


// these are handled specially by RedisClient
RedisSentinelClient.prototype.HMGET =
RedisSentinelClient.prototype.hmget = function(){
  var client = this.activeMasterClient;
  return client.hmget.apply(client, arguments);
};

RedisSentinelClient.prototype.HMSET =
RedisSentinelClient.prototype.hmset = function(){
  var client = this.activeMasterClient;
  return client.hmset.apply(client, arguments);
};



// helper to get client.
// (even tho activeMasterClient is public, this is clearer)
RedisSentinelClient.prototype.getMaster = function getMaster() {
  return this.activeMasterClient;
};


// get static values from client, also pass-thru
// not all of them... @review!
[ 'connection_id', 'ready', 'connected', 'connections', 'commands_sent', 'connect_timeout',
  'monitoring', 'closing', 'server_info',
  'stream' /* ?? */
  ].forEach(function(staticProp){
    RedisSentinelClient.prototype.__defineGetter__(staticProp, function(){
      return this.activeMasterClient[staticProp];
    });

    // might as well have a setter too...?
    RedisSentinelClient.prototype.__defineSetter__(staticProp, function(newVal){
      return this.activeMasterClient[staticProp] = newVal;
    });
  });


// log(type, msgs...)
// type is 'info', 'error', 'debug' etc
RedisSentinelClient.prototype.log = function log() {
  var logger = this.options.logger || console;
  var args = Array.prototype.slice.call(arguments);
  logger.log.apply(logger, args);
};
// debug(msgs...)
RedisSentinelClient.prototype.debug = function debug() {
  if (this.options.debug) {
    var args = ['debug'].concat(Array.prototype.slice.call(arguments));
    this.log.apply(this, args);
  }
};


RedisSentinelClient.prototype.onError = function(error) {
  // redundant? debug instead?
  this.log('error', error);

  this.emit('error', error);
};

exports.RedisSentinelClient = RedisSentinelClient;



// called by RedisClient::createClient() when options.sentinel===true
// similar args for backwards compat,
// but does not support sockets (see above)
exports.createClient = function (port, host, options) {
  // allow the arg structure of RedisClient, but collapse into options for constructor.
  //
  // note, no default_host or default_port,
  // see http://redis.io/topics/sentinel.
  // also no net_client or allowNoSocket, see above.
  // this could be a problem w/ backwards compatibility.
  if (arguments.length === 1) {
    options = arguments[0] || {};
  }
  else {
    options = options || {};
    options.port = port;
    options.host = host;
  }

  // @todo use a net client like redisClient?

  return new RedisSentinelClient(options);
};
