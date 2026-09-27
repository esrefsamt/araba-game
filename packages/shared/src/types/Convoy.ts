import type { QuaternionTuple, Vector3Tuple } from './Vehicle.js';

export interface RigidBodyStateSnapshot {
  position: Vector3Tuple;
  rotation: QuaternionTuple;
  linearVelocity: Vector3Tuple;
  angularVelocity: Vector3Tuple;
}

export interface ConvoyStateSnapshot {
  pathProgress: number;
  speed: number;
  truck: RigidBodyStateSnapshot;
  trailer: RigidBodyStateSnapshot;
}
