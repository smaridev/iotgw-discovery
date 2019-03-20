#!/usr/bin/env node

const MQTT = require('mqtt');
const async = require("async");
const os = require('os');
const http = require('http');

const nodeCleanup = require('node-cleanup');

const LOGGING_LEVELS = {
  FATAL: 0,
  ERROR: 1,
  DEBUG: 3,
  INFO: 2
};

const APP_STATE_INIT = 'initialize';
const APP_STATE_RUNNING = 'running';
const APP_STATE_STOPPING = 'stopping';

const DISCOVER_RESTART_TIMEOUT = 1000; 
const APPLICATION_START_TIMEOUT = 5 * 1000; 

let sendRegistrationTaskId = null;

let applicationState = APP_STATE_INIT;

let mqttClient = null;
let config = {};

var registration_success = 0;

const topic_snapupdates_subscribe = "dscmgr/pushsnapreq";
const topic_registration_subscribe= "dscmgr/registered";


// cleanup 
nodeCleanup(function (exitCode, signal) {
    // release resources here before node exits 
    console.log('Cleaning up...');
    if (mqttClient) {
        mqttClient.end();
        console.log('Closed MQTT client...');
    }
});

const loadConfig = () => {
  const c = require('./config');
  let { topic } = c.mqtt;
  //topic = topic.replace('{hostname}', os.hostname());
  c.mqtt.topic = topic;
  return c;
};

const log = (msg, data = '', level = LOGGING_LEVELS.DEBUG) => {
  const appLoggingLevel = LOGGING_LEVELS[config.app.loggingLevel];
  if (level <= LOGGING_LEVELS.ERROR) {
    console.error(msg, data);
  }
  else if (level <= appLoggingLevel) {
    console.log(`${msg}`, data);
  }
};

const sendRegistration = () => {
    var eth0 = os.networkInterfaces()['eth0'];
    const msg = JSON.stringify({
        tpid: getserial(),
        message: "dscmgr/registration",
        timestamp: Math.round((new Date()).getTime() / 1000),
        networkdetails: eth0,
        hostname:  os.hostname(),
        status: "Registering",
        });

    mqttClient.publish("dscmgr/registration", msg);
    registration_success = 0;
    log(`Send Device Registration to cloud ${msg}`);

    // Test code for snap install/update/remove
     /* const test_message = JSON.stringify({
        action: "install",
        //snaps: ["hello", "hello-world", "hmon", "httplab"] 
        snaps: ["hello"]
        });

    handleSnapUpdate(test_message);
    */
};

const brokerConnect = (mqttConfig) => {
  const mqttAddr = `${mqttConfig.host}:${mqttConfig.port}`;
  log(`Connecting to: ${mqttAddr}`);

  const connectionProblemsHandler = (err) => {
    if (err) {
      log('Connection problem, disconnecting ...', err, LOGGING_LEVELS.ERROR);
    }
  };
  log('new MQTT client creation ...');
  mqttClient = MQTT.connect({
    protocol: 'mqtt',
    host: mqttConfig.host,
    port: mqttConfig.port,
    reconnecting: true
  });

  mqttClient.on('connect', () => {
    log(`Successfully connected to: ${mqttAddr}`, '', LOGGING_LEVELS.INFO);
    sendRegistration();    
    mqttClient.subscribe(topic_registration_subscribe);
    mqttClient.subscribe(topic_snapupdates_subscribe);
    mqttClient.removeListener('message', mqttOnMessageEventHandler);
    // Setup MQTT client on new message event
    mqttClient.on('message', mqttOnMessageEventHandler);
    log(`Subscribe mqtt topic to: ${mqttAddr}`, '', LOGGING_LEVELS.INFO);
    console.log("Starting service.");
    applicationState = APP_STATE_RUNNING;
  });
  
  mqttClient.on('close', connectionProblemsHandler);
  mqttClient.on('error', connectionProblemsHandler);
  mqttClient.on('end', connectionProblemsHandler);
  mqttClient.on('offline', connectionProblemsHandler);
};

// Handler for new MQTT messages
var mqttOnMessageEventHandler = function (topic, message) {
    switch (topic) {
    case topic_snapupdates_subscribe:
      return handleSnapUpdate(message)
    case topic_registration_subscribe:
      return handleRegistrationAccept(message)
  }
}

// Handler for Registration accept MQTT messages
var handleRegistrationAccept = function (message) {
    // message is Buffer 
    var payload = JSON.parse(message);
    registration_success = 1;
    publishSnapInfo("dscmgr/snaplist");
}

const push_snap_options = {
  socketPath: '/run/snapd.socket',
  path: '/v2/snaps',
};

const httpSnapPushResponsecallback = (res, snap_name, snap_resp, num_snaps) => {
  res.setEncoding('utf8');
  res.on('data', data => {
    var temp = JSON.parse(data);
    temp['snap_name'] = snap_name;
    snap_resp.push(temp);
    // Got responses for all the push snap requests, Send the status and update.
    if (snap_resp.length == num_snaps) {
        console.log('httpSnapPushResponsecallback send responses ', snap_resp);
        const msg = JSON.stringify({
            tpid: getserial(),
            message: "dscmgr/pushsnapresp",
            timestamp: Math.round((new Date()).getTime() / 1000),
            hostname:  os.hostname(),
            response:  snap_resp
        });

        mqttClient.publish("dscmgr/pushsnapresp", msg);
        log(`Publish systemsnapinfo to cloud ${msg}`);
        publishSnapInfo("dscmgr/snapupdatedlist");
    }
  });
  res.on('error', data => console.error(data));
}

// Handler for new MQTT messages
var handleSnapUpdate = function (message) {
    var snap_resp = [];
    snap_msg = JSON.parse(message);
    log('handleSnapUpdate snaps length', snap_msg.snaps.length);

    // Multi snap operation not working, Bug reported to snapcraft
    const install_json = JSON.stringify({
        action: snap_msg.action
    });

    for(var i=0; i<snap_msg.snaps.length; i++){
        log('handleSnapUpdate snaps ', snap_msg.snaps[i]);
    
        const push_snap_options = {
            socketPath: '/run/snapd.socket',
            path: '/v2/snaps/' + snap_msg.snaps[i],
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': install_json.length
            }
        };

        let snap_name = snap_msg.snaps[i];
        const req = http.request(push_snap_options, function (res) { httpSnapPushResponsecallback(res, snap_name,
                                 snap_resp, snap_msg.snaps.length); } );

        req.on('error', (error) => {
                snap_resp.push(error);
                console.error('request error', error);
        });

        req.write(install_json);
        req.end;
    }

}

function getserial() {
   var serial = null;
   var fs = require('fs');
   var content = fs.readFileSync('/proc/cpuinfo', 'utf8');
   var cont_array = content.split("\n");
   var serial_line = cont_array.filter(data => {
            return data.indexOf('Serial') === 0
   });

   if (serial_line.length > 0) {
      serial = serial_line[0].split(":")[1];
   }
   
   return serial;
}

const get_snap_options = {
  socketPath: '/run/snapd.socket',
  path: '/v2/snaps',
};

const httpResponsecallback = (res, topic) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.setEncoding('utf8');
  res.on('data', data => {
    var snap_list = JSON.parse(data)['result']; 
    sendSnapInfo(snap_list, topic);
  });
  res.on('error', data => console.error(data));
};

const sendSnapInfo = (snap_list, topic) => {

    const msg = JSON.stringify({
        tpid: getserial(),
        message: topic,
        timestamp: Math.round((new Date()).getTime() / 1000),
        hostname:  os.hostname(),
        snaplist: snap_list
        });

    mqttClient.publish(topic, msg);
    log(`Publish systemsnapinfo to cloud ${msg}`);
};

const publishSnapInfo = (topic) => {
    const clientRequest = http.request(get_snap_options, function (res) { httpResponsecallback (res, topic); });
    clientRequest.end();
};

const startSendingTask = (appConfig) => {
  log('Start Sending Task ...');
  return setInterval(() => {
    if (mqttClient) {
       sendRegistration(); 
    }
  }, appConfig.app.sendInterval);
};

const stopSendingTask = () => {
  log('Stop Sending Task ...');
  clearInterval(sendRegistrationTaskId);
};

// App Utils
// ==========
const start = (appConfig) => {
  log('Starting with Config: ', appConfig, LOGGING_LEVELS.INFO);

  brokerConnect(appConfig.mqtt);
  if (registration_success == 0) {
    sendRegistrationTaskId = startSendingTask(appConfig);
  }
  else if (registration_success == 1){
    clearInterval(sendRegistrationTaskId);
  }

    // Test code for snap install/update/remove
    const test_message = JSON.stringify({
        action: "install",
        //snaps: ["hello", "hello-world", "hmon", "httplab"]
        snaps: ["hello"]
        });

    handleSnapUpdate(test_message);
};

const stop = () => {
  if (applicationState === APP_STATE_STOPPING) return;
  applicationState = APP_STATE_STOPPING;
  log('Stopping ...');
  stopSendingTask();
  brokerDisconnect();
};


const init = () => {
  config = loadConfig();
  log('Initialize ...');
  // Set exit handlers
  process.on('exit', () => {
    stop();
  });
  process.on('uncaughtException', (err) => {
    log('uncaughtException:', err, LOGGING_LEVELS.FATAL);
    try {
      stop();
    }
    catch (stopErr) {
      log('Error while stop:', stopErr, LOGGING_LEVELS.FATAL);
    }
    finally {
      process.exit(-1);
    }
  });
  return config;
};

// Application
// ==========
init();
setTimeout(() => {
  start(config);
}, APPLICATION_START_TIMEOUT);
