import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import ROSLIB from 'roslib';
import { RobotConnection } from '../src/ros_connection.js';
import { RobotControl } from '../src/robot_control.js';
import { Runner } from '../src/blockly/runtime.js';

function setup(context) {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  globalThis.location = new URL('http://localhost:5174');
  const topics = [];
  const ros = new EventEmitter();
  ros.connect = () => {};
  context.mock.method(ROSLIB, 'Ros', function () {
    return ros;
  });
  context.mock.method(ROSLIB, 'Topic', function (options) {
    const topic = {
      ...options,
      sent: [],
      subscribe(receive) {
        this.receive = receive;
      },
      unsubscribe() {},
      publish(message) {
        this.sent.push(JSON.parse(message.data));
      },
    };
    topics.push(topic);
    return topic;
  });
  const connection = new RobotConnection();
  const control = new RobotControl(connection);
  ros.emit('connection');
  const find = (name) => topics.find((topic) => topic.name === name);
  const robots = [
    { ns: 'rt5', topics: { scan: '/rt5/scan' } },
    { ns: 'rt6', topics: { scan: '/rt6/scan' } },
  ];
  const discover = (entries) => find('web/robots').receive({ data: JSON.stringify(entries) });
  discover(robots);
  return { connection, control, ros, find, discover, robots };
}

test('disconnect cancels movement; reconnect requires a fresh command', (context) => {
  const { connection, control, ros, find } = setup(context);
  control.move('front', 0.1);
  assert.equal(find('web/command').sent.length, 1);
  ros.emit('close');
  context.mock.timers.tick(3000);
  assert.equal(find('web/command').sent.length, 1);
  assert.throws(() => control.move('front', 0.1), /No robot connected/);
  ros.emit('connection');
  context.mock.timers.tick(500);
  assert.equal(find('web/command').sent.length, 1);
  assert.equal(connection.ready, true);
  control.move('front', 0.1);
  assert.equal(find('web/command').sent.length, 2);
});

test('switching stops the previous robot without delayed stops on the next one', (context) => {
  const { connection, control, find } = setup(context);
  control.move('front', 0.1);
  connection.select('rt6');
  control.turn('left', 0.2);
  context.mock.timers.tick(200);
  assert.deepEqual(find('web/stop').sent, [{ robot: 'rt5' }]);
  assert.equal(find('web/command').sent.at(-1).robot, 'rt6');
});

test('a disappearing robot cancels its program before automatic selection', async (context) => {
  const { connection, control, find, discover, robots } = setup(context);
  const runner = new Runner(control);
  connection.addEventListener('beforeselect', () => runner.stop());
  const result = runner.run([
    { op: 'move', direction: 'front', speed: 0.1, seconds: 10 },
    { op: 'turn', direction: 'left', speed: 0.1, seconds: 1 },
  ]);
  discover([robots[1]]);
  assert.equal(await result, 'stopped');
  assert.equal(connection.selected, 'rt6');
  assert.ok(find('web/command').sent.every((command) => command.robot === 'rt5'));
  assert.ok(find('web/stop').sent.every((command) => command.robot === 'rt5'));
});

test('a sensor-only connection never publishes commands on selection', (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  globalThis.location = new URL('http://localhost:5174');
  const ros = new EventEmitter();
  ros.connect = () => {};
  context.mock.method(ROSLIB, 'Ros', function () {
    return ros;
  });
  const names = [];
  context.mock.method(ROSLIB, 'Topic', function (options) {
    names.push(options.name);
    return { subscribe() {}, unsubscribe() {} };
  });
  const connection = new RobotConnection();
  ros.emit('connection');
  connection.select('rt5');
  connection.select('rt6');
  assert.deepEqual(names, ['web/robots', 'web/distances']);
});

test('camera URLs preserve ROS topic slashes for web_video_server', (context) => {
  const { connection } = setup(context);
  assert.equal(
    connection.videoUrl('/rt5/camera/image_raw'),
    'http://localhost:8080/stream?topic=/rt5/camera/image_raw&type=mjpeg&width=640&height=360&quality=60&qos_profile=sensor_data',
  );
  assert.equal(
    connection.videoUrl('/rt54/camera/image_raw', { transport: 'compressed' }),
    'http://localhost:8080/stream?topic=/rt54/camera/image_raw&type=mjpeg&width=640&height=360&quality=60&qos_profile=sensor_data&default_transport=compressed',
  );
});

test('commands publish through the installed roslib Topic implementation', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const ros = new ROSLIB.Ros();
  const sent = [];
  ros.sendEncodedMessage = (encoded) => sent.push(JSON.parse(encoded));
  const connection = new EventTarget();
  Object.assign(connection, { ros, selected: 'rt5', connected: true, ready: true });
  const control = new RobotControl(connection);
  control.move('front', 0.1);
  control.led('front', '#ff0000');
  control.stop();
  const publications = sent.filter((message) => message.op === 'publish');
  assert.deepEqual(
    publications.map((message) => message.topic),
    ['web/command', 'web/led', 'web/stop'],
  );
  assert.deepEqual(JSON.parse(publications[0].msg.data), { robot: 'rt5', vx: 0.1, vy: 0, wz: 0 });
});
