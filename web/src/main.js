import './style.css';
import { RobotConnection } from './ros_connection.js';
import { RobotControl } from './robot_control.js';
import { RobotViewer } from './viewer.js';
import { previews, savePreviews } from './previews.js';

const TERMINAL_PORT = Number(new URLSearchParams(location.search).get('terminal')) || 7681;

const element = (id) => document.getElementById(id);
const connection = new RobotConnection();
const control = new RobotControl(connection);
const viewer = new RobotViewer(element('scene'), connection);
const keys = new Set();
let holding = false;
const log = (message) => {
  const item = document.createElement('li');
  item.textContent = message;
  element('log').prepend(item);
  while (element('log').children.length > 8) element('log').lastChild.remove();
};
const formatNumber = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
const fresh = (entry) => entry && performance.now() - entry.at < 2000;
const attempt = (action) => {
  try {
    action();
  } catch (error) {
    log(error.message);
  }
  renderControls();
};

// --- Robot choice -------------------------------------------------------------------------------
function renderRobots() {
  const select = element('robot');
  select.replaceChildren(
    ...connection.robots.map((robot) => {
      const option = document.createElement('option');
      option.value = robot.ns;
      option.textContent = robot.name + (robot.ns ? ` (${robot.ns})` : '');
      option.selected = robot.ns === connection.selected;
      return option;
    }),
  );
  select.hidden = connection.robots.length < 2;
  const robot = connection.robot;
  element('online').classList.toggle('connected', connection.connected && Boolean(robot));
  if (!connection.connected) {
    element('connection').textContent = 'Disconnected from rosbridge';
  } else if (robot) {
    element('connection').textContent = `Connected to ${robot.name}`;
  } else {
    element('connection').textContent = 'No robot found';
  }
  element('robot-title').textContent = robot?.name || 'No robot';
  const generations = { 3: 'Gen 3', '3lite': 'Gen 3 Lite' };
  let detail = 'Waiting for a robot on this ROS domain';
  if (robot) {
    detail = generations[robot.generation] || 'Robotont';
    if (robot.ns) detail += ` · namespace ${robot.ns}`;
  }
  element('robot-detail').textContent = detail;
  element('points-label').hidden = !robot?.topics.points;
  setImages();
  renderControls();
}
element('robot').onchange = () => {
  keys.clear();
  holding = false;
  connection.select(element('robot').value);
  log(`Switched to ${connection.robot?.name}`);
};
function setImages() {
  const robot = connection.robot;
  for (const [kind, name] of [
    ['rgb', robot?.topics.rgb],
    ['depth', robot?.topics.depth],
  ]) {
    const image = element(kind),
      source =
        name && previews[kind]
          ? connection.videoUrl(name, {
              transport: kind === 'rgb' ? robot.rgb_transport || 'raw' : 'raw',
            })
          : '';
    if (image.dataset.source !== source) {
      image.dataset.source = source;
      image.dataset.since = performance.now();
      if (source) image.src = source;
      else image.removeAttribute('src');
    }
    image.hidden = !source;
    const placeholder = element(kind + '-placeholder'),
      off = Boolean(name) && !previews[kind];
    placeholder.dataset.text ??= placeholder.textContent;
    placeholder.textContent = off ? 'Preview off' : placeholder.dataset.text;
    placeholder.hidden = Boolean(source);
    if (!source) element(kind + '-status').textContent = off ? 'Off' : 'No data';
    element(kind + '-toggle').textContent = previews[kind] ? 'Hide' : 'Show';
    element(kind + '-toggle').hidden = !name;
  }
  renderImageStatus();
}

// --- Driving ------------------------------------------------------------------------------------
function velocity(direction) {
  const speed = Number(element('move-speed').value),
    turn = Number(element('turn-speed').value);
  return {
    front: { vx: speed, vy: 0, wz: 0 },
    back: { vx: -speed, vy: 0, wz: 0 },
    left: { vx: 0, vy: speed, wz: 0 },
    right: { vx: 0, vy: -speed, wz: 0 },
    'turn-left': { vx: 0, vy: 0, wz: turn },
    'turn-right': { vx: 0, vy: 0, wz: -turn },
  }[direction];
}
function stopMotion() {
  if (holding) {
    holding = false;
    attempt(() => control.stop());
  }
}
function emergencyStop() {
  keys.clear();
  holding = false;
  control.stop();
  log('Stop sent');
}
element('stop').onclick = emergencyStop;
for (const button of document.querySelectorAll('[data-drive]')) {
  button.onpointerdown = (event) => {
    if (button.disabled) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    holding = true;
    attempt(() => control.drive(velocity(button.dataset.drive)));
  };
  button.onpointerup = stopMotion;
  button.onpointercancel = stopMotion;
  button.onlostpointercapture = stopMotion;
}
window.addEventListener('pointerup', () => {
  if (!keys.size) stopMotion();
});
for (const [id, output, suffix] of [
  ['move-speed', 'move-value', 'm/s'],
  ['turn-speed', 'turn-value', 'rad/s'],
]) {
  element(id).oninput = () => {
    element(output).textContent = element(id).value + ' ' + suffix;
  };
}
const keyDirections = {
  w: 'front',
  ArrowUp: 'front',
  s: 'back',
  ArrowDown: 'back',
  a: 'left',
  ArrowLeft: 'left',
  d: 'right',
  ArrowRight: 'right',
  q: 'turn-left',
  e: 'turn-right',
};
function updateKeys() {
  const values = [...keys].map((key) => velocity(keyDirections[key]));
  if (!values.length) {
    stopMotion();
    return;
  }
  const combined = values.reduce(
    (total, v) => ({
      vx: total.vx + v.vx,
      vy: total.vy + v.vy,
      wz: total.wz + v.wz,
    }),
    { vx: 0, vy: 0, wz: 0 },
  );
  const norm = Math.hypot(combined.vx, combined.vy),
    limit = Number(element('move-speed').value);
  if (norm > limit) {
    combined.vx *= limit / norm;
    combined.vy *= limit / norm;
  }
  combined.wz = Math.max(-1, Math.min(1, combined.wz));
  holding = true;
  attempt(() => control.drive(combined));
}
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input,select,textarea,iframe,[contenteditable]')) return;
  if (event.code === 'Space' || event.key === 'Escape') {
    event.preventDefault();
    if (!event.repeat) emergencyStop();
    return;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!keyDirections[key] || event.repeat || !connection.ready) return;
  event.preventDefault();
  keys.add(key);
  updateKeys();
});
document.addEventListener('keyup', (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (keys.delete(key)) {
    event.preventDefault();
    updateKeys();
  }
});
window.addEventListener('blur', () => {
  keys.clear();
  stopMotion();
});
window.addEventListener('pagehide', () => control.stop());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    keys.clear();
    stopMotion();
  }
});

// --- Lights -------------------------------------------------------------------------------------
element('apply-led').onclick = () =>
  attempt(() => {
    control.led(element('led-side').value, element('led-color').value);
    element('led-last').textContent =
      `Last command: ${element('led-side').value} ${element('led-color').value}`;
    log('Light color sent');
  });
element('off-led').onclick = () =>
  attempt(() => {
    control.led(element('led-side').value, '#000000');
    log('Lights off sent');
  });

// --- Terminal (ttyd, started by web.launch.py) --------------------------------------------------
element('terminal-toggle').onclick = () => {
  const frame = element('terminal'),
    open = frame.hidden;
  frame.hidden = !open;
  if (open) frame.src = `http://${location.hostname}:${TERMINAL_PORT}/`;
  else frame.removeAttribute('src');
  element('terminal-toggle').textContent = open ? 'Close terminal' : 'Open terminal';
};

// --- Telemetry ----------------------------------------------------------------------------------
function renderControls() {
  const robot = connection.robot,
    ready = connection.connected && Boolean(robot);
  for (const button of document.querySelectorAll('[data-drive]')) button.disabled = !ready;
  element('drive-status').textContent = ready ? 'Ready' : 'No robot';
  element('led-status').textContent = robot?.led ? 'Available' : 'Unavailable';
  element('led-note').textContent = robot?.led
    ? 'Colors are set in manual mode; the first command stops the start-up animation.'
    : 'No LED module is listening on this robot.';
  for (const id of ['led-side', 'led-color', 'apply-led', 'off-led'])
    element(id).disabled = !ready || !robot?.led;
}
function renderImageStatus() {
  // an MJPEG <img> has width once its first frame arrived
  for (const kind of ['rgb', 'depth']) {
    const image = element(kind);
    if (!image.dataset.source) continue;
    element(kind + '-status').textContent = image.naturalWidth
      ? 'Live'
      : performance.now() - Number(image.dataset.since) > 6000
        ? 'No frames from the robot'
        : 'Waiting for frames…';
  }
}
function renderTelemetry() {
  renderImageStatus();
  const odometryEntry = connection.telemetry.odom;
  const batteryEntry = connection.telemetry.battery;
  const odometry = fresh(odometryEntry) ? odometryEntry.data : null;
  const battery = fresh(batteryEntry) ? batteryEntry.data : null;

  element('battery').textContent = '—';
  if (!battery) {
    element('battery-detail').textContent = 'No fresh battery data';
  } else if (battery.invalid) {
    element('battery-detail').textContent =
      `No valid reading from the robot (it reports ${formatNumber(battery.rawVoltage, 1)} V)`;
  } else if (!battery.present) {
    element('battery-detail').textContent = 'Battery not present';
  } else {
    element('battery').textContent =
      battery.percentage === null
        ? `${formatNumber(battery.voltage, 1)} V`
        : `${Math.round(battery.percentage * 100)}%`;
    let detail = `${formatNumber(battery.voltage, 1)} V`;
    if (battery.temperature !== null) detail += ` · ${formatNumber(battery.temperature, 1)} °C`;
    element('battery-detail').textContent = detail;
  }

  element('speed').textContent = odometry
    ? `${formatNumber(Math.hypot(odometry.vx, odometry.vy))} m/s`
    : '—';
  element('rotation').textContent = odometry
    ? `Turning ${formatNumber(odometry.wz)} rad/s`
    : 'No motion data';
}
function renderDistances() {
  element('distances').replaceChildren();
  for (const direction of ['front', 'back', 'left', 'right']) {
    const term = document.createElement('dt'),
      value = document.createElement('dd');
    term.textContent = direction;
    const reading = connection.distances[connection.selected]?.[direction];
    value.textContent = reading?.available ? formatNumber(reading.value) + ' m' : 'Unavailable';
    value.title = reading?.reason || '';
    const pair = document.createElement('div');
    pair.append(term, value);
    element('distances').append(pair);
  }
}
element('points').onchange = () => viewer.setPoints(element('points').checked);
for (const kind of ['rgb', 'depth'])
  element(kind + '-toggle').onclick = () => {
    previews[kind] = !previews[kind];
    savePreviews();
    setImages();
  };
const renderScanToggle = () =>
  (element('scan-toggle').textContent = previews.scan ? 'Hide' : 'Show');
element('scan-toggle').onclick = () => {
  previews.scan = !previews.scan;
  savePreviews();
  renderScanToggle();
  viewer.setScan(previews.scan);
};
renderScanToggle();
if (!previews.scan) viewer.setScan(false);
element('view-follow').onclick = () => viewer.follow();
element('view-top').onclick = () => viewer.topDown();
connection.addEventListener('beforeselect', () => {
  keys.clear();
  holding = false;
});
connection.addEventListener('connection', () => {
  if (!connection.connected) {
    keys.clear();
    holding = false;
  }
});
for (const name of ['connection', 'robots', 'select'])
  connection.addEventListener(name, renderRobots);
connection.addEventListener('telemetry', renderTelemetry);
connection.addEventListener('distances', renderDistances);
setInterval(renderTelemetry, 1000);
renderRobots();
renderTelemetry();
renderDistances();
