import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Fit the camera to an object's bounding box (design doc §7, auto-fit on load
 * and on Reset). Positions the camera along a fixed isometric-ish direction at
 * a distance that frames the whole model, and points OrbitControls at the box
 * center. Also adjusts near/far so large or tiny models don't clip.
 */
export function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  object: THREE.Object3D,
  offset = 1.3,
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const fov = (camera.fov * Math.PI) / 180;
  let distance = maxDim / 2 / Math.tan(fov / 2);
  distance *= offset;

  const direction = new THREE.Vector3(1, 0.8, 1).normalize();
  camera.position.copy(center).add(direction.multiplyScalar(distance));

  camera.near = Math.max(distance / 1000, 0.001);
  camera.far = distance * 1000;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}
