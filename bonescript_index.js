// Copyright (C) 2011 - Texas Instruments, Jason Kridner 
//
// 
var fs = require('fs');
var child_process = require('child_process');
var http = require('http');
var url = require('url');
var path = require('path');
var cluster = require('cluster');
var eeprom = require('./eeprom');
bone = require('./bone').bone;

var myrequire = function(packageName, onfail) {
    var y = {};
    try {
        y = require(packageName);
        y.exists = true;
    } catch(ex) {
        y.exists = false;
        console.log("Optional package '" + packageName + "' not loaded");
        if(onfail) onfail();
    }
    return(y);
};

var socketio = myrequire('socket.io', function() {
    console.log("Dynamic web features not enabled");
});
var systemd = myrequire('systemd', function() {
    console.log("Startup as socket-activated service under systemd not enabled");
});

var misc = myrequire('./build/Release/misc');

OUTPUT = exports.OUTPUT = "out";
INPUT = exports.INPUT = "in";
INPUT_PULLUP = exports.INPUT_PULLUP = "in_pullup";
HIGH = exports.HIGH = 1;
LOW = exports.LOW = 0;
LSBFIRST = exports.LSBFIRST = 1;  // used in: shiftOut(dataPin, clockPin, bitOrder, val)
MSBFIRST = exports.MSBFIRST = 0;
CHANGE = exports.CHANGE = "both";
RISING = exports.RISING = "rising";
FALLING = exports.FALLING = "falling";

// Keep track of allocated resources
var gpio = [];
var pwm = [];

getPinMode = exports.getPinMode = function(pin, callback) {
    var muxFile = '/sys/kernel/debug/omap_mux/' + pin.mux;
    //console.log('getPinMode(' + pin.key + '): ' + muxFile);
    var parseMux = function(readout) {
        //console.log('' + readout);
        var mode = {};
        // The format read from debugfs looks like this:
        // name: mcasp0_axr0.spi1_d1 (0x44e10998/0x998 = 0x0023), b NA, t NA
        // mode: OMAP_PIN_OUTPUT | OMAP_MUX_MODE3
        // signals: mcasp0_axr0 | ehrpwm0_tripzone | NA | spi1_d1 | mmc2_sdcd_mux1 | NA | NA | gpio3_16
        var breakdown = '';
        try {
            breakdown = readout.split('\n');
        } catch(ex) {
            console.log('Unable to parse mux readout "' + readout + '": ' + ex);
            return(mode);
        }
        try {        
            // Parse the muxmode number, '3' in the above example
            mode.mux = breakdown[1].split('|')[1].substr(-1);
            // Parse the mux register value, '0x0023' in the above example
            var pinData = parseInt(breakdown[0].split('=')[1].substr(1,6));
            //console.log('pinData = ' + pinData);
            mode.slew = (pinData & 0x40) ? 'slow' : 'fast';
            mode.rx = (pinData & 0x20) ? 'enabled' : 'disabled';
            var pullup = (pinData & 0x18) >> 3;
            switch(pullup) {
            case 1:
                mode.pullup = 'disabled';
                break;
            case 2:
                mode.pullup = 'pullup';
                break;
            case 0:
                mode.pullup = 'pulldown';
                break;
            case 3:
            default:
                console.error('Unknown pullup value: '+pullup);
            }
        } catch(ex2) {
            console.log('Unable to parse mux mode "' + breakdown + '": ' + ex2);
        }
        try {
            mode.options = breakdown[2].split('|');
            for(var option in mode.options) {
                var x = ''+mode.options[option];
                try {
                    mode.options[option] = x.replace(/ /g, '').replace('signals:', '');
                } catch(ex) {
                    console.log('Unable to parse option "' + x + '": ' + ex);
                    mode.options[option] = 'NA';
                }
            }
        } catch(ex3) {
            console.log('Unable to parse options "' + breakdown + '": ' + ex3);
            mode.options = null;
        }
        return(mode);
    };
    var readMux = function(err, data) {
        var mode = parseMux(data);
        mode.pin = pin.key;
        callback(mode);
    };
    if(callback) {
        path.exists(muxFile, function(exists) {
            if(exists) {
                fs.readFile(muxFile, 'utf8', readMux);
            } else {
                // default mux
                callback({'pin': pin.key});
                console.log('getPinMode(' + pin.key + '): no valid mux data');
            }
        });
    } else {
        try {
            var data = fs.readFileSync(muxFile, 'utf8');
            var mode = parseMux(data);
            mode.pin = pin.key;
            return(mode);
        } catch(ex) {
            console.log('getPinMode(' + pin.key + '): ' + ex);
            return({'pin': pin.key});
        }
    }
};

pinMode = exports.pinMode = function(pin, direction, mux, pullup, slew, callback) {
    if(direction == INPUT_PULLUP) pullup = 'pullup';
    pullup = pullup || ((direction == INPUT) ? 'pulldown' : 'disabled');
    slew = slew || 'fast';
    mux = mux || 7; // default to GPIO mode
    //console.log('pinmode(' + [pin.key, direction, mux, pullup, slew].join(',') + ')');
    
    if(!pin.mux) {
        console.log('Invalid pin object for pinMode: ' + pin);
        throw('Invalid pin object for pinMode: ' + pin);
    }

    var muxFile = '/sys/kernel/debug/omap_mux/' + pin.mux;
    var gpioFile = '/sys/class/gpio/gpio' + pin.gpio + '/value';
    
    // Handle case where pin is allocated as a gpio-led
    if(pin.led) {
        if((direction != OUTPUT) || (mux != 7)) {                    
            console.log('pinMode only supports GPIO output for LEDs: ' + pin);
            if(callback) callback(false);
            return(false);
        }
        gpioFile = '/sys/class/leds/beaglebone::' + pin.led + '/brightness';
    }

    // Figure out the desired value
    var pinData = 0;
    if(slew == 'slow') pinData |= 0x40;
    if(direction != OUTPUT) pinData |= 0x20;
    switch(pullup) {
    case 'disabled':
        pinData |= 0x08;
        break;
    case 'pullup':
        pinData |= 0x10;
        break;
    default:
        break;
    }
    pinData |= (mux & 0x07);
    
    try {
        var fd = fs.openSync(muxFile, 'w');
        fs.writeSync(fd, pinData.toString(16), null);
    } catch(ex) {
        console.error('Unable to configure mux for pin ' + pin + ': ' + ex);
        gpio[n] = {};
        if(callback) callback(false);
        return(false);
    }

    // Enable GPIO, if not already done
    var n = pin.gpio;
    if(mux == 7) {
        if(!gpio[n] || !gpio[n].path) {
            gpio[n] = {'path': gpioFile};
    
            if(pin.led) {
                fs.writeFileSync(
                    "/sys/class/leds/beaglebone::" + pin.led + "/trigger",
                    "gpio");
            } else {    
                // Export the GPIO controls
                var exists = path.existsSync(gpioFile);
                if(exists) {
                    //console.log("gpio: " + n + " already exported.");
                    fs.writeFileSync("/sys/class/gpio/gpio" + n + "/direction",
                        direction, null);
                } else {
                    try {
                        fs.writeFileSync("/sys/class/gpio/export", "" + n, null);
                        fs.writeFileSync("/sys/class/gpio/gpio" + n + "/direction",
                            direction, null);
                    } catch(ex) {
                        console.error('Unable to export gpio-' + n + ': ' + ex);
                        var gpioUsers = fs.readFileSync('/sys/kernel/debug/gpio', 'utf-8');
                        gpioUsers = gpioUsers.split('\n');
                        for(var x in gpioUsers) {
                            var y = gpioUsers[x].match(/gpio-(\d+)\s+\((\S+)\s*\)/);
                            if(y && y[1] == n) {
                                console.error('gpio-' + n + ' consumed by ' + y[2]);
                            }
                        }
                        gpio[n] = {};
                        if(callback) callback(false);
                        return(false);
                    }
                }
            }
        }
    } else {
        gpio[n] = {};
    }
    
    if(callback) callback(true);
    return(true);
};

digitalWrite = exports.digitalWrite = function(pin, value, callback) {
    var gpioFile = '/sys/class/gpio/gpio' + pin.gpio + '/value';
    if(pin.led) {
        gpioFile = '/sys/class/leds/beaglebone::' + pin.led + '/brightness';
    }
    if(callback) {
        fs.writeFile(gpioFile, '' + value, null, callback);
    } else {
        fs.writeFileSync(gpioFile, '' + value, null);
    }
    return(true);
};

digitalRead = exports.digitalRead = function(pin, callback) {
    var gpioFile = '/sys/class/gpio/gpio' + pin.gpio + '/value';
    if(callback) {
        var readFile = function(err, data) {
            var value = parseInt(data);
            callback({'value':value});
        };
        fs.readFile(gpioFile, readFile);
        return(true);
    }
    var value = parseInt(fs.readFileSync(gpioFile));
    return(value);
};

analogRead = exports.analogRead = function(pin, callback) {
    var ainFile = '/sys/bus/platform/devices/tsc/ain' + (pin.ain+1);
    if(callback) {
        var readFile = function(err, data) {
            var value = parseInt(data) / pin.scale;
            callback({'value': value});
        };
        fs.readFile(ainFile, readFile);
        return(true);
    }
    var data = parseInt(fs.readFileSync(ainFile));
    if(isNaN(data)) {
        throw('analogRead(' + pin.key + ') returned ' + data);
    }
    data = data / pin.scale;
    if(isNaN(data)) {
        throw('analogRead(' + pin.key + ') scaled to ' + data);
    }
    return(data);
}; 

smoothedRead = exports.smoothedRead = function(pin, callback) {
    var start = Date.now().valueOf();
    //console.log("smoothedRead called: "+start);
    var ret = 0;
    var micSize = 20;
    var start = Date.now().valueOf();
    var maxVal = 0;
    for (i = 0; i < micSize; i++)
    {
        //console.log("smoothed: "+ret);
	// reading will be the waveform from the mic
	// We only care about the overall volume level,
	// and it'll be biased to always give a +ve
	// voltage level.
	// So, we subtract half the peak (possible) to
	// get it to a waveform unbiased (i.e. above and
	// below 0), then take the absolute value to give
	// us the amount between the waveform and 0 on
	// both sides of 0
	var reading = Math.abs(analogRead(pin)-0.332);
	if (reading > maxVal) maxVal = reading;
	ret = ret+reading;
    }
    //console.log("done reading: "+(Date.now().valueOf()-start));
    //console.log("Max: "+maxVal);
    ret = ret/micSize;
    //console.log("smoothedRead: "+ret);
    if(callback) {
        //console.log("smoothedRead has a callback");
	callback({'value': ret});
	return(true);
    }
    return(ret);
}; 

bluetoothscan = exports.bluetoothscan = function(callback) {
    console.log("bluetoothscan called");
    var results = [];
    var child = child_process.exec("hcitool inq", function(err, stdout, stderr) {
        var devices = stdout.split("\n");
	for (var i = 0; i < devices.length; i++) {
	    // The output we're interested in will be of the form
	    // <bt addr>    clock offset: <offset>    class: <class>
	    var components = devices[i].match(/\W+([0-9A-Fa-f:]+)\W+clock offset: (0x[0-9A-Fa-f]+)\W+class: (0x[0-9A-Fa-f]+)/);
	    if (components) {
	        // Found an interesting line of output
		var dev = {
		    btaddr: components[1],
		    clock_offset: components[2],
		    class: components[3]
		};
		results.push(dev);
	    }
	}
	//console.log(results);
        if(callback) {
	    callback({'value': results});
	    return(true);
	}
    });
    return results;
};

shiftOut = exports.shiftOut = function(dataPin, clockPin, bitOrder, val, callback) {
  var i;
  var bit;
  for (i = 0; i < 8; i++)  
  {
    if (bitOrder == LSBFIRST) 
    {
         bit = val & (1 << i);
    } else
    {
         bit = val & (1 << (7 - i));
    }

    digitalWrite(dataPin, bit);
    digitalWrite(clockPin, HIGH);
    digitalWrite(clockPin, LOW);            
  }
};

attachInterrupt = exports.attachInterrupt = function(pin, handler, mode, callback) {
    if(!gpio[pin.gpio]) {
        if(callback) callback({'pin':pin, 'attached':false, 'configured':false});
        return(false);
        if(callback) callback({'pin':pin, 'attached':false, 'configured':true});
        return(false);
    };
    console.log('Adding handler ' + handler + ' to pin ' + pin.key);
    console.log('attachInterrupt #-2');
    var gpioFile = '/sys/class/gpio/gpio' + pin.gpio + '/value';
    console.log('attachInterrupt #-1' + pin.gpio + ' ' + mode);
    fs.writeFileSync('/sys/class/gpio/gpio' + pin.gpio + '/edge', mode);
    console.log('attachInterrupt #0');
    var handler = (typeof handler === "string") ? eval('(' + handler + ')') : handler;
    console.log('attachInterrupt #1 '+handler);
    var intHandler = function(m) {
    console.log('interrupt fired!');
        var output = handler({'pin':pin, 'value':m.value});
        if(output && callback) callback({'pin':pin, 'output':output});
    };
    console.log('attachInterrupt #2');
    var intProc;
    if(child_process.fork) {
        intProc = child_process.fork(__dirname + '/gpioint.js');
    } else {
        var fork = require('fork');
        intProc = fork.fork(__dirname + '/gpioint.js');
    }
    console.log('attachInterrupt #3 '+intHandler);
    intProc.on('message', intHandler);
    intProc.on('exit', function(code, signal) {
        if(callback) callback({
            'pin':pin,
            'code':code,
            'signal':signal,
            'died':true
        });
    });
    intProc.send({'pin':pin, 'mode':mode, 'file':gpioFile});
    gpio[pin.gpio].intProc = intProc;
    process.on('SIGTERM', function() {
        intProc.kill();
        if(callback) callback({'pin':pin, 'died':true});
    });
    console.log('attachInterrupt #4');
    if(callback) callback({'pin':pin, 'attached':true});
    return(true);
};

detachInterrupt = exports.detachInterrupt = function(pin, callback) {
    if(!gpio[pin.gpio] || !gpio[pin.gpio].intProc) {
        if(callback) callback({'pin':pin, 'detached':false});
        return(false);
    };
    gpio[pin.gpio].intProc.kill();
    delete gpio[pin.gpio].intProc;
    if(callback) callback({'pin':pin, 'detached':true});
};

// See http://processors.wiki.ti.com/index.php/AM335x_PWM_Driver's_Guide
analogWrite = exports.analogWrite = function(pin, value, freq, callback) {
    freq = freq || 1000;
    var path = '/sys/class/pwm/' + pin.pwm.path;
    //var curMode = getPinMode(pin);
    // Not yet possible to implement this test
    //if(curMode.direction != OUTPUT) {
    //    throw(pin.key + ' must be configured as OUTPUT for analogWrite()');
    //}
    if(!pin.pwm) {
        throw(pin.key + ' does not support analogWrite()');
    }
    if(pwm[pin.pwm.path] && pwm[pin.pwm.path].key) {
        if(pwm[pin.pwm.path].key != pin.key) {
            throw(pin.key + ' requires pwm ' + pin.pwm.name +
                ' but it is already in use by ' +
                pwm[pin.pwm].key
            );
         }
    } else {
        pwm[pin.pwm.path] = {};
        pwm[pin.pwm.path].key = '' + pin.key;
        pwm[pin.pwm.path].freq = freq;
        pinMode(pin, OUTPUT, pin.pwm.muxmode, 'disabled', 'fast');

        // Clear up any unmanaged usage
        fs.writeFileSync(path+'/request', '0');

        // Allocate and configure the PWM
        fs.writeFileSync(path+'/request', '1');
        fs.writeFileSync(path+'/period_freq', freq);
        fs.writeFileSync(path+'/polarity', '0');
        fs.writeFileSync(path+'/run', '1');
    }
    if(pwm[pin.pwm.path].freq != freq) {
        fs.writeFileSync(path+'/run', '0');
        fs.writeFileSync(path+'/duty_percent', '0');
        fs.writeFileSync(path+'/period_freq', freq);
        fs.writeFileSync(path+'/run', '1');
        pwm[pin.pwm.path].freq = freq;
    }
    fs.writeFileSync(path+'/duty_percent', Math.round(value*100));
    if(callback) callback();
};

getEeproms = exports.getEeproms = function(callback) {
    var EepromFiles = {
        '/sys/bus/i2c/drivers/at24/1-0050/eeprom': { type: 'bone' },
        '/sys/bus/i2c/drivers/at24/3-0054/eeprom': { type: 'cape' },
        '/sys/bus/i2c/drivers/at24/3-0055/eeprom': { type: 'cape' },
        '/sys/bus/i2c/drivers/at24/3-0056/eeprom': { type: 'cape' },
        '/sys/bus/i2c/drivers/at24/3-0057/eeprom': { type: 'cape' },
    };
    var eeproms = eeprom.readEeproms(EepromFiles);
    if(eeproms == {}) {
        console.warn('No valid EEPROM contents found');
    }
    if(callback) {
        callback(eeproms);
    }
    return(eeproms);
};

myWorkers = [];
addLoop = exports.addLoop = function(loopFunc, loopDelay, callback) {
    console.log('Adding loop ' + loopFunc);
    loopDelay = loopDelay || 0;
    callback = callback || function(){};
    var worker = cluster.fork();
    process.on('SIGTERM', function() {
        worker.kill();
    });
    worker.on('message', function(m) {
        //console.log('Parent got message ' + JSON.stringify(m));
        if(m.resolve) {
            var pairs = [];
            for(var name in m.resolve) {
                var value = eval(m.resolve[name]);
                pairs.push({
                    'name': m.resolve[name],
                    'value': value.toString()
                });
            }
            worker.send({'vars': pairs});
        } else if(m.callback) {
            callback({'callback':m.value});
        }
    });
    myWorkers.push({
        'worker': worker,
        'loopFunc': loopFunc.toString(),
        'loopDelay': loopDelay
    });
    if(callback) {
        callback({'loopid':worker.pid});
    }
    return(worker.pid);
};

getLoops = exports.getLoops = function(callback) {
    var loops = {};
    for(var worker in myWorkers) {
        var id = myWorkers[worker].worker.pid;
        loops[id] = {};
        loops[id].loopFunc = myWorkers[worker].loopFunc;
        loops[id].loopDelay = myWorkers[worker].loopDelay;
    }
    if(callback) {
        callback({'loops':loops});
    }
    return(loops);
};

removeLoop = exports.removeLoop = function(loopId, callback) {
    for(var worker in myWorkers) {
        if(myWorkers[worker].worker.pid == loopId) {
            process.kill(loopId);
            myWorkers.splice(worker, 1);
            if(callback) {
                callback({'loopId':loopId, 'removed':true});
            }
            return(true);
	}
    }
    if(callback) {
        callback({'loopId':loopId, 'removed':false});
    }
    return(false);
};

doEval = exports.doEval = function(evalFunc, callback) {
    var evalFunc = (typeof evalFunc === "string") ? eval('(' + evalFunc + ')') : evalFunc;
    var value = evalFunc(callback);
    if(callback) callback({'value':value});
    return(value);
};

// Wait for some time
if(misc.exists) {
    delay = exports.delay = function(milliseconds, callback) {
        misc.delay(milliseconds);
        if(callback) callback();
    };
} else {
    delay = exports.delay = function(milliseconds, callback) {
        var startTime = new Date().getTime();
        while(new Date().getTime() < startTime + milliseconds) {
        }
        if(callback) callback();
    };
}

// This is where everything is meant to happen
var needsToRun = true;
run = exports.run = function(run_setup, run_loop) {
    if(!needsToRun) return(false);
    needsToRun = false;
    run_setup = run_setup || setup || (function(){});
    //run_setup = run_setup.toString();
    run_loop =
        ((typeof run_loop === "function") ? [ run_loop ] : false) ||
        ((typeof run_loop === "object") ? run_loop : false) ||
        ((typeof loop === "function") ? [ loop ] : false) ||
        ((typeof loop === "object") ? loop : false) ||
        [];
    if(cluster.isMaster) {
        //console.log('Evaluating ' + run_setup);
        //eval('(' + run_setup + ')();');
        run_setup();
        for(var x in run_loop) addLoop(run_loop[x], 0);
        cluster.on('death', function(worker) {
            console.log('Loop with PID ' + worker.pid + ' died');
        });
    } else {
        var childResolve = function childResolve(varNames) {
            var message = {'resolve': varNames};
            //console.log('Child sending message ' + JSON.stringify(message));
            process.send(message);
            var myListener = function(m) {
                //console.log('Child got message ' + JSON.stringify(m));
                if(m.vars) {
                    for(var pair in m.vars) {
                        try {
                            //console.log(m.vars[pair].name + ' = ' + m.vars[pair].value);
                            eval(m.vars[pair].name + ' = ' + m.vars[pair].value);
                        } catch(ex) {
                            console.error('Unable to eval loop in ' + JSON.stringify(m));
                        }
                    }
                    var repeat = function repeat() {
                        var value = loopFunc();
                        if(value) process.send({'callback':true, 'value':value});
                        if(loopDelay) setTimeout(repeat, loopDelay);
                        else process.nextTick(repeat);
                    };
                    try {
                        repeat();
                    } catch(ex) {
                        var errName = ex.toString().match(/^ReferenceError: (\w+)\b/);
                        if(errName && errName[1]) {
                            childResolve([errName[1]]);
                        } else {
                            throw(ex);
                        }
                    }
                    process.removeListener('message', myListener);
                    process.on('message', function(m) {
                        if(m.readVars) {
                            console.log('Child got message ' + JSON.stringify(m));
                            var message = {
                                'readVars': true,
                                'loopFunc': loopFunc,
                                'loopDelay': loopDelay
                            };
                            process.send(message);
                        }
                    });
                }
            };
            process.on('message', myListener);
        };
        childResolve(['loopFunc', 'loopDelay']);
    }
    return(true);
};
process.nextTick(run);

// This is a helper function for web servers
var loadFile = function(uri, subdir, res, type) {
    var filename = path.join(subdir, uri);
    path.exists(
        filename,
        function(exists) {
            if(!exists) {
                res.writeHead(404, {"Content-Type": "text/plain"});
                res.write("Error 404: '" + uri + "' Not Found\n");
                res.end();
                return;
            }
            if(type == "binary") {
                fs.readFile(
                    filename,
                    "binary",
                    function(err, file) {
                        if(err) {
                            res.writeHead(500, {"Content-Type": "text/plain"});
                            res.write(err + "\n");
                            res.end();
                            return;
                        }
                        res.writeHead(200);
                        res.write(file, "binary");
                        res.end();
                    }
                );
            } else {
                fs.readFile(
                    filename,
                    encoding='utf8',
                    function(err, file) {
                        if(err) {
                            res.writeHead(500, {"Content-Type": "text/plain"});
                            res.write(err + "\n");
                            res.end();
                            return;
                        }
                        res.writeHead(200, {"Content-Type": type});
                        res.write("" + file);
                        res.end();
                    }
                );
            }
        }
    );
};

// most heavily borrowed from https://github.com/itchyny/browsershell
var spawn = function(socket) {
    var stream = '';
    var timer;
    var len = 0;
    var c;

    var send = function (data) {
       // add data to the stream
       stream += data.toString();
       ++len;

       // clear any existing timeout if it exists
       if(timer) clearTimeout(timer);

       // set new timeout
       timer = setTimeout(function () {
           socket.emit('shell', stream);
           stream = '';
           len = 0;
       }, 100);

       // send data if over threshold
       if(len > 1000)
       {
           clearTimeout(timer);
           socket.emit('shell', stream);
           stream = '';
           len = 0;
       }
    };

    var receive = function (msg) {
        if(!c) {
            try {
                console.log('Spawning bash');
                c = child_process.spawn('/bin/bash', ['-i'], {customFds: [-1, -1, -1]});
                c.stdout.on('data', send);
                c.stderr.on('data', send);
                c.on('exit', function() {
                    socket.emit('shell', send('\nexited\n'));
                    c = undefined;
                });
                socket.on('disconnect', function () {
                    console.log('Killing bash');
                    c.kill('SIGHUP');
                });
            } catch(ex) {
                c = undefined;
                send('Error invoking bash');
                console.log('Error invoking bash');
            }
        }
        if(c) {
            if(msg) {
                c.stdin.write(msg + '\n', encoding='utf-8');
            }
        } else {
            console.log('Unable to invoke child process');
        }
    };
    receive();

    return(receive);
};

var addSocketListeners = function() {};
if(socketio.exists) {
    addSocketListeners = function(server, onconnect) {
        var io = socketio.listen(server);
        io.set('log level', 2);
        console.log('Listening for new socket.io clients');
        io.sockets.on('connection', function(socket) {
            console.log('Client connected');

            // on disconnect
            socket.on('disconnect', function() {
                console.log('Client disconnected');
            });

            var shell = spawn(socket);
            var echo = function(data, callback) {
                console.log(data);
                callback({'data': data});
            };
            var platform = function(callback) {
                var msg = {'platform': bone};
                if(callback) callback(msg);
                return(msg);
            };

            var myfuncs = {
                'bluetoothscan': { func: bluetoothscan, args: [] },
                'digitalWrite': { func: digitalWrite, args: [ 'pin', 'value' ] },
                'digitalRead': { func: digitalRead, args: [ 'pin' ] },
                'analogRead': { func: analogRead, args: [ 'pin' ] },
                'smoothedRead': { func: smoothedRead, args: [ 'pin' ] },
                'analogWrite': { func: analogWrite, args: [ 'pin', 'value', 'freq' ] },
                'pinMode': { func: pinMode, args: [ 'pin', 'direction', 'mux', 'pullup', 'slew' ] },
                'shiftOut': { func: shiftOut, args: [ 'dataPin', 'clockPin', 'bitOrder', 'val' ] },
                'attachInterrupt': { func: attachInterrupt, args: [ 'pin', 'handler', 'mode' ] },
                'detachInterrupt': { func: detachInterrupt, args: [ 'pin' ] },
                'getPinMode': { func: getPinMode, args: [ 'pin' ] },
                'getEeproms': { func: getEeproms, args: [] },
                'delay': { func: delay, args: [] },
                'platform': { func: platform, args: [] },
                'shell': { func: shell, args: [ 'command' ] },
                'echo': { func: echo, args: [ 'data' ] },
                'doEval': { func: doEval, args: [ 'evalFunc' ] },
                'addLoop': { func: addLoop, args: [ 'loopFunc', 'loopDelay' ] },
                'getLoops': { func: getLoops, args: [] },
                'removeLoop': { func: removeLoop, args: [ 'loopid' ] }
            };
            var callMyFunc = function(name, m) {
                var callback = function(resp) {
                    resp = resp || {};
                    if(m && m.seq) resp.seq = m.seq;
                    // TODO: consider setting 'oneshot'
                    socket.emit(name, resp);
                };
                try {
                    var callargs = [];
                    for(var arg in myfuncs[name].args) {
                        var argname = myfuncs[name].args[arg];
                        if(m) {
                            callargs.push(m[argname]);
                        } else {
                            callargs.push(undefined);
                        }
                    }
                    callargs.push(callback);
                    myfuncs[name].func.apply(this, callargs);
                } catch(ex) {
                    console.log('Error handing ' + name + ' message: ' + ex);
                }
            }
            var addSocketX = function(name) {
                socket.on(name, function(m) { callMyFunc(name, m); });
            };
            for(var myfunc in myfuncs) {
                addSocketX(myfunc);
            }

            // call user-provided on-connect function
            if(typeof onconnect == 'function')
                onconnect(socket);
        });
    };
}

exports.Server = function(port, subdir, onconnect) {
    port = port || (process.env.LISTEN_PID > 0 ? 'systemd' : 80);
    subdir = path.join(process.cwd(), subdir);
    var rss_proxy = function(uri, req, res) {
	if (uri.match(/newspod/)) {
	    console.log("newspod requested");
	    var proxy = http.createClient(80, 'downloads.bbc.co.uk');
	    proxy.on('error', function(e) {
		console.log('error with proxy: '+e.message);
                res.writeHead(404, {"content-type": "text/plain"});
                res.write("error 404: '" + uri + "' not found\n");
                res.end();
	    });
            var proxy_request = proxy.request(req.method, '/podcasts/radio4/today/rss.xml', req.headers);
	    proxy_request.addListener('response', function (proxy_response) {
	        proxy_response.addListener('data', function(chunk) {
	            res.write(chunk, 'binary');
	        });
	        proxy_response.addListener('end', function() {
	            res.end();
	        });
	        res.writeHead(proxy_response.statusCode, proxy_response.headers);
	    });
            proxy_request.addListener('error', function(e) {
	        console.log('problem with request: '+e.message);
	    });
	    req.addListener('data', function(chunk) {
	        proxy_request.write(chunk, 'binary');
	    });
	    req.addListener('end', function() {
	        proxy_request.end();
	    });
	} else if (uri.match(/weather/)) {
	    // Need to pull out the "ref" parameter in this case, but default
	    // to Manchester if it isn't present
	    var ref = 2643123;
            var parsed_url = url.parse(req.url, true);
	    if (parsed_url.query.ref) {
		ref = parsed_url.query.ref;
	    }
	    console.log("weather requested for "+ref);
	    var proxy = http.createClient(80, 'open.live.bbc.co.uk');
	    proxy.on('error', function(e) {
		console.log('error with proxy: '+e.message);
                res.writeHead(404, {"content-type": "text/plain"});
                res.write("error 404: '" + uri + "' not found\n");
                res.end();
	    });
            var proxy_request = proxy.request(req.method, '/weather/feeds/en/'+ref+'/3dayforecast.rss', req.headers);
	    proxy_request.addListener('response', function (proxy_response) {
	        proxy_response.addListener('data', function(chunk) {
	            res.write(chunk, 'binary');
	        });
	        proxy_response.addListener('end', function() {
	            res.end();
	        });
	        res.writeHead(proxy_response.statusCode, proxy_response.headers);
	    });
	    req.addListener('data', function(chunk) {
	        proxy_request.write(chunk, 'binary');
	    });
	    req.addListener('end', function() {
	        proxy_request.end();
	    });
	} else if (uri.match(/filmdates/)) {
	    console.log("films requested");
	    var options = {
		hostname: 'www.filmdates.co.uk',
		port: 80,
		path: '/rss/out_this_week/',
                method: req.method,
	        headers: { 'User-Agent': 'Mozilla', 'Accept': 'text/html,application/xml' }
	    }
	    var proxy = http.request(options, function(proxy_resp) {
		proxy_resp.on('data', function(chunk) {
		    res.write(chunk, 'binary');
		});
		proxy_resp.on('end', function() {
		    res.end();
		});
		res.writeHead(proxy_resp.statusCode, proxy_resp.headers);
	    });
	    req.addListener('data', function(chunk) {
	        proxy.write(chunk, 'binary');
	    });
	    req.addListener('end', function() {
	        proxy.end();
	    });
	} else {
	    // not expecting to get here, so 404 it
            res.writeHead(404, {"content-type": "text/plain"});
            res.write("error 404: '" + uri + "' not found\n");
            res.end();
	}
    };
    var handler = function(req, res) {
        var uri = url.parse(req.url).pathname;
        if(uri == '/') {
            loadFile('index.html', subdir, res, "text/html");
        } else {
            if(uri.match(/\.js$/i)) {
                loadFile(uri, subdir, res, "application/javascript");
            } else if(uri.match(/\.css$/i)) {
                loadFile(uri, subdir, res, "text/css");
            } else if(uri.match(/\.htm(.)$/i)) {
                loadFile(uri, subdir, res, "text/html");
            } else if(uri.match(/\.svg$/i)) {
                loadFile(uri, subdir, res, "image/svg+xml");
            } else if(uri.match(/\.(jpg|png|ico)$/i)) {
                loadFile(uri, subdir, res, "binary");
            } else if(uri.match(/.+proxy.+\.php$/i)) {
		rss_proxy(uri, req, res);
	    } else if(uri == '/PerceptiveMedia/') {
	        loadFile('PerceptiveMedia/index.html', subdir, res, "text/html");
	    } else if(uri.match(/\.(mp3|wav|ogg)$/i)) {
		loadFile(uri, subdir, res, "binary");
            } else {
                loadFile(uri, subdir, res, "text/plain");
            }
        }
    };
    this.server6 = http.createServer();
    this.server6.addListener('request', handler);
    addSocketListeners(this.server6, onconnect);
    this.server = http.createServer();
    this.server.addListener('request', handler);
    addSocketListeners(this.server, onconnect);
    this.begin = function() {
        this.server6.listen(port, '::0');
        this.server.listen(port);
    };
};
