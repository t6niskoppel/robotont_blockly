import { Blockly, toolbox, example } from './blocks.js';
import { compile } from './compiler.js';
import { Runner } from './runtime.js';
import { RobotConnection } from '../ros_connection.js';
import { RobotControl } from '../robot_control.js';
import { RobotViewer } from '../viewer.js';
import { previews, savePreviews } from '../previews.js';

const element = (id) => document.getElementById(id);
const workspace = Blockly.inject('workspace', {
  toolbox,
  trashcan: true,
  media: '/vendor/media/',
  zoom: { controls: true, wheel: true, startScale: 0.9 },
  move: { scrollbars: true, drag: true, wheel: true },
});
new ResizeObserver(() => Blockly.svgResize(workspace)).observe(element('workspace'));
const connection = new RobotConnection();
const control = new RobotControl(connection);
const viewer = new RobotViewer(element('scene'), connection);
element('follow').onclick = () => viewer.follow();
element('top').onclick = () => viewer.topDown();
if (!previews.scan) viewer.setScan(false);
element('scan-toggle').onclick = () => {
  previews.scan = !previews.scan;
  savePreviews();
  viewer.setScan(previews.scan);
  render();
};
element('camera-toggle').onclick = () => {
  previews.rgb = !previews.rgb;
  savePreviews();
  render();
};
let runner = null;
const log = (message) => {
  const item = document.createElement('li');
  item.textContent = message;
  element('log').prepend(item);
  while (element('log').children.length > 40) element('log').lastChild.remove();
};
const busy = (value) => {
  for (const id of ['run', 'example', 'load', 'robot-choice']) element(id).disabled = value;
};
const loadExample = () => {
  workspace.clear();
  Blockly.serialization.workspaces.load(example(element('example').value), workspace);
};
loadExample();
element('example').onchange = loadExample;
element('robot-choice').onchange = () => {
  if (!runner) connection.select(element('robot-choice').value);
};
element('run').onclick = async () => {
  try {
    const program = compile(workspace);
    runner = new Runner(control, {
      onLog: log,
      onStep: (id) => workspace.highlightBlock(id),
    });
    busy(true);
    await runner.run(program);
  } catch (error) {
    log(error.message);
  } finally {
    busy(false);
    runner = null;
    render();
  }
};
element('stop').onclick = async () => {
  try {
    await (runner ? runner.stop() : control.stop());
    log('Stop requested');
  } catch (error) {
    log(error.message);
  }
};
element('save').onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(Blockly.serialization.workspaces.save(workspace), null, 2)], {
      type: 'application/json',
    }),
  );
  const download = document.createElement('a');
  download.href = url;
  download.download = 'robotont-program.json';
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
element('load').onclick = () => element('file').click();
element('file').onchange = async (event) => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 1000000) throw new Error('Program file is too large');
    const data = JSON.parse(await file.text());
    const previous = Blockly.serialization.workspaces.save(workspace);
    try {
      workspace.clear();
      Blockly.serialization.workspaces.load(data, workspace);
      compile(workspace);
    } catch (error) {
      workspace.clear();
      Blockly.serialization.workspaces.load(previous, workspace);
      throw error;
    }
    log('Program loaded');
  } catch (error) {
    log('Cannot load program: ' + error.message);
  } finally {
    event.target.value = '';
  }
};
function stopProgram() {
  if (runner) runner.stop();
  else control.stop();
}
window.addEventListener('pagehide', stopProgram);
window.addEventListener('blur', stopProgram);
connection.addEventListener('beforeselect', stopProgram);
connection.addEventListener('connection', () => {
  if (!connection.connected) stopProgram();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopProgram();
});

function render() {
  const robot = connection.robot;
  element('robot-choice').replaceChildren(
    ...connection.robots.map((entry) => {
      const option = document.createElement('option');
      option.value = entry.ns;
      option.textContent = entry.name + (entry.ns ? ` (${entry.ns})` : '');
      option.selected = entry.ns === connection.selected;
      return option;
    }),
  );
  element('connection').textContent = !connection.connected
    ? 'Not connected to rosbridge; motion stops by itself.'
    : robot
      ? `Connected to ${robot.name} · ${robot.generation === '3' ? 'Gen 3' : robot.generation === '3lite' ? 'Gen 3 Lite' : 'Robotont'}${robot.ns ? ' · ' + robot.ns : ''}`
      : 'No robot found on this ROS domain';
  element('run').disabled = !connection.ready || Boolean(runner);
  element('scan-toggle').textContent = previews.scan ? 'Hide lidar' : 'Show lidar';
  element('camera-toggle').textContent = previews.rgb ? 'Hide camera' : 'Show camera';
  element('camera-toggle').hidden = !robot?.topics.rgb;
  const source =
    robot?.topics.rgb && previews.rgb
      ? connection.videoUrl(robot.topics.rgb, {
          width: 320,
          height: 180,
          transport: robot.rgb_transport || 'raw',
        })
      : '';
  if (element('camera').dataset.source !== source) {
    element('camera').dataset.source = source;
    if (source) element('camera').src = source;
    else element('camera').removeAttribute('src');
  }
  element('camera').hidden = !source;
  element('camera-note').hidden = Boolean(source) && Boolean(element('camera').naturalWidth);
  element('camera-note').textContent = source
    ? 'Waiting for camera frames…'
    : robot?.topics.rgb
      ? 'Camera preview off'
      : 'No camera';
}
function showDistances() {
  element('distances').replaceChildren();
  for (const direction of ['front', 'back', 'left', 'right']) {
    const label = document.createElement('dt');
    label.textContent = direction;
    const value = document.createElement('dd');
    const reading = connection.distances[connection.selected]?.[direction];
    value.textContent = reading?.available
      ? `${reading.value.toFixed(2)} m${reading.clear ? ' or more' : ''}`
      : 'Unavailable';
    value.title = reading?.reason || '';
    element('distances').append(label, value);
  }
}
setInterval(() => {
  const image = element('camera');
  if (image.dataset.source) {
    element('camera-note').hidden = Boolean(image.naturalWidth);
    if (!image.naturalWidth) element('camera-note').textContent = 'No frames from the robot yet';
  }
}, 1000);
for (const name of ['connection', 'robots', 'select']) connection.addEventListener(name, render);
connection.addEventListener('distances', showDistances);
render();
showDistances();
