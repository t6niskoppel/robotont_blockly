// 3D view of the robot's surroundings, built from ros3d (Robot Web Tools): TF axes, laser scan and point cloud.
import * as ROS3D from 'ros3d';
import * as THREE from 'three';
import { TFTree } from './tf.js';

export class RobotViewer {
  constructor(element, connection) {
    this.connection = connection;
    this.element = element;
    this.viewer = new ROS3D.Viewer({
      divID: element.id,
      width: element.clientWidth || 600,
      height: element.clientHeight || 360,
      antialias: true,
      background: '#f5f8f7',
      alpha: 1,
      intensity: 0.9,
    });
    this.viewer.addObject(
      new ROS3D.Grid({
        num_cells: 20,
        cellSize: 0.5,
        color: '#b9c9c1',
        lineWidth: 1,
      }),
    );
    this.viewer.camera.up.set(0, 0, 1);
    this.tf = new TFTree(connection.ros, 'base_footprint');
    this.tf.addEventListener('frames', () => this.tf.setFixedFrame(this.base()));
    this.layers = [];
    this.showPoints = false; // rosbridge is slow with whole point clouds, so they are opt-in
    this.showScan = true;
    new ResizeObserver(() => this.viewer.resize(element.clientWidth, element.clientHeight)).observe(
      element,
    );
    connection.addEventListener('select', () => this.show());
    connection.addEventListener('robots', () => {
      const topics = JSON.stringify(connection.robot?.topics);
      if (topics !== this.displayedTopics) this.show();
    });
    connection.addEventListener('connection', () => this.show());
    this.topDown();
    this.show();
  }
  base() {
    const namespace = this.connection.selected;
    const candidates = [namespace ? `${namespace}/base_footprint` : null, 'base_footprint'].filter(
      Boolean,
    );
    return candidates.find((frame) => this.tf.frames().includes(frame)) || candidates[0];
  }
  show() {
    for (const layer of this.layers) layer.unsubscribe?.();
    for (const object of this.layerObjects || []) {
      object.unsubscribeTf?.();
      this.viewer.scene.remove(object);
      object.traverse((child) => {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          for (const material of child.material) material.dispose();
        } else child.material?.dispose();
      });
    }
    this.layers = [];
    this.layerObjects = [];
    const robot = this.connection.robot;
    this.displayedTopics = JSON.stringify(robot?.topics);
    if (!this.connection.ready) return;
    this.tf.setFixedFrame(this.base());
    // The robot: a round disc with a clear arrow pointing forward (+x, up on the screen in the top-down view).
    const footprint = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.19, 64),
      new THREE.MeshBasicMaterial({ color: 0xb9e3d8, side: THREE.DoubleSide }),
    );
    disc.position.z = 0.005;
    footprint.add(disc);
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.2, 64),
      new THREE.MeshBasicMaterial({ color: 0x0f5c4d, side: THREE.DoubleSide }),
    );
    rim.position.z = 0.01;
    footprint.add(rim);
    const arrowShape = new THREE.Shape(); // tail, shaft and head of an arrow along +x
    arrowShape.moveTo(-0.1, -0.035);
    arrowShape.lineTo(0.04, -0.035);
    arrowShape.lineTo(0.04, -0.09);
    arrowShape.lineTo(0.15, 0);
    arrowShape.lineTo(0.04, 0.09);
    arrowShape.lineTo(0.04, 0.035);
    arrowShape.lineTo(-0.1, 0.035);
    arrowShape.lineTo(-0.1, -0.035);
    const arrow = new THREE.Mesh(
      new THREE.ShapeGeometry(arrowShape),
      new THREE.MeshBasicMaterial({ color: 0x0f5c4d, side: THREE.DoubleSide }),
    );
    arrow.position.z = 0.015;
    footprint.add(arrow);
    this.viewer.addObject(footprint);
    this.layerObjects.push(footprint);
    const rootObject = new THREE.Group();
    this.viewer.scene.add(rootObject);
    this.layerObjects.push(rootObject);
    if (robot.topics.scan && this.showScan) {
      this.layers.push(
        new ROS3D.LaserScan({
          ros: this.connection.ros,
          topic: robot.topics.scan,
          tfClient: this.tf,
          rootObject,
          material: { size: 0.09, color: 0xc2410c },
          max_pts: 2000,
        }),
      );
    }
    if (robot.topics.points && this.showPoints) {
      this.layers.push(
        new ROS3D.PointCloud2({
          ros: this.connection.ros,
          topic: robot.topics.points,
          tfClient: this.tf,
          rootObject,
          material: { size: 0.02 },
          max_pts: 20000,
          colorsrc: 'rgb',
          throttle_rate: 500,
        }),
      );
    }
  }
  setPoints(on) {
    this.showPoints = on;
    this.show();
  }
  setScan(on) {
    this.showScan = on;
    this.show();
  }
  // Looking down from behind the robot: forward (x) is up on the screen. 'Follow' keeps a slight tilt.
  topDown() {
    this.viewer.camera.position.set(-0.02, 0, 6);
    this.viewer.cameraControls?.update?.();
  }
  follow() {
    this.viewer.camera.position.set(-1.6, 0, 3.4);
    this.viewer.cameraControls?.update?.();
  }
}
