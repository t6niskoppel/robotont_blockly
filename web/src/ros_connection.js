// Reads robot discovery and sensor data through rosbridge. Motion lives in robot_control.js.
import ROSLIB from 'roslib';

export class RobotConnection extends EventTarget {
  constructor() {
    super();
    const params = new URLSearchParams(location.search);
    this.host = location.hostname;
    this.videoPort = Number(params.get('video')) || 8080;
    this.url = `ws://${this.host}:${Number(params.get('rosbridge')) || 9090}`;
    this.connected = false;
    this.robots = [];
    this.selected = null; // Empty string is the root namespace; null means no robot.
    this.distances = {};
    this.telemetry = {};
    this.subscriptions = [];
    this.telemetrySubscriptions = [];
    this.ros = new ROSLIB.Ros();
    this.ros.on('connection', () => {
      clearTimeout(this.reconnectTimer);
      this.connected = true;
      this.listen();
      this.emit('connection');
    });
    this.ros.on('close', () => {
      this.connected = false;
      this.distances = {};
      this.telemetry = {};
      this.emit('connection');
      this.emit('distances');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.ros.connect(this.url), 2000);
    });
    this.ros.on('error', (error) => this.emit('error', error));
    this.ros.connect(this.url);
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  get robot() {
    return this.robots.find((robot) => robot.ns === this.selected) || null;
  }

  get ready() {
    return this.connected && this.robot !== null;
  }

  listen() {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions = [];
    const subscribe = (name, receive) => {
      const subscription = new ROSLIB.Topic({
        ros: this.ros,
        name,
        messageType: 'std_msgs/msg/String',
      });
      subscription.subscribe((message) => receive(JSON.parse(message.data)));
      this.subscriptions.push(subscription);
    };
    // Relative names resolve in the namespace of this page's rosbridge, so only its own robot answers
    subscribe('web/robots', (robots) => {
      const previousTopics = JSON.stringify(this.robot?.topics);
      this.robots = robots;
      if (!robots.some((robot) => robot.ns === this.selected)) {
        this.select(robots[0]?.ns ?? null);
      } else if (previousTopics !== JSON.stringify(this.robot.topics)) {
        this.listenTelemetry();
      }
      this.emit('robots');
    });
    subscribe('web/distances', (distances) => {
      this.distances = distances;
      this.emit('distances');
    });
    this.listenTelemetry();
  }

  select(namespace) {
    if (namespace === this.selected) return;
    this.emit('beforeselect'); // A controller can stop the previous robot here.
    this.selected = namespace;
    this.telemetry = {};
    this.listenTelemetry();
    this.emit('select');
  }

  listenTelemetry() {
    for (const subscription of this.telemetrySubscriptions) subscription.unsubscribe();
    this.telemetrySubscriptions = [];
    if (!this.ready) return;
    const watch = (key, name, messageType, convert) => {
      if (!name) return;
      const subscription = new ROSLIB.Topic({
        ros: this.ros,
        name,
        messageType,
        throttle_rate: 200,
        queue_length: 1,
      });
      subscription.subscribe((message) => {
        this.telemetry[key] = { data: convert(message), at: performance.now() };
        this.emit('telemetry');
      });
      this.telemetrySubscriptions.push(subscription);
    };
    watch('odom', this.robot.topics.odom, 'nav_msgs/msg/Odometry', (message) => {
      const position = message.pose.pose.position;
      const orientation = message.pose.pose.orientation;
      const velocity = message.twist.twist;
      return {
        x: position.x,
        y: position.y,
        yaw: Math.atan2(
          2 * (orientation.w * orientation.z + orientation.x * orientation.y),
          1 - 2 * (orientation.y ** 2 + orientation.z ** 2),
        ),
        vx: velocity.linear.x,
        vy: velocity.linear.y,
        wz: velocity.angular.z,
      };
    });
    watch('battery', this.robot.topics.battery, 'sensor_msgs/msg/BatteryState', (message) => {
      // The firmware uses large sentinel values when a sensor has no reading.
      const voltageOk =
        Number.isFinite(message.voltage) && message.voltage >= 5 && message.voltage <= 25.5;
      const temperatureOk =
        Number.isFinite(message.temperature) &&
        message.temperature >= -20 &&
        message.temperature <= 100;
      return {
        present: message.present && voltageOk,
        voltage: voltageOk ? message.voltage : null,
        rawVoltage: message.voltage,
        percentage:
          voltageOk && message.percentage >= 0 && message.percentage <= 1
            ? message.percentage
            : null,
        temperature: temperatureOk ? message.temperature : null,
        invalid: message.present && !voltageOk,
      };
    });
  }

  videoUrl(name, { width = 640, height = 360, quality = 60, transport = 'raw' } = {}) {
    const params = new URLSearchParams({
      type: 'mjpeg',
      width,
      height,
      quality,
      qos_profile: 'sensor_data',
    });
    // Select the ROS-side transport independently of the browser's MJPEG encoding.
    if (transport !== 'raw') params.set('default_transport', transport);
    // web_video_server expects the ROS topic slashes to remain unescaped.
    return `http://${this.host}:${this.videoPort}/stream?topic=${name}&${params}`;
  }

  distance(direction) {
    if (!this.ready) throw new Error('No robot connected');
    const reading = this.distances[this.selected]?.[direction];
    if (!reading?.available)
      throw new Error(reading?.reason || `${direction} distance is unavailable`);
    return reading.value;
  }
}
