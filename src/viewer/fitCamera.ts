import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Fit the camera to an object's bounding box (design doc §7, auto-fit on load
 * and on Reset). Positions the camera along a fixed isometric-ish direction at
 * a distance that frames the whole model, and points OrbitControls at the box
 * center. Also adjusts near/far so large or tiny models don't clip.
 *
 * Handles both perspective and orthographic cameras — for the latter it sizes
 * the frustum (and leaves zoom at 1) instead of choosing a distance.
 */
export function fitCameraToObject(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  controls: OrbitControls,
  object: THREE.Object3D,
  offset = 1.3,
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const direction = new THREE.Vector3(1, 0.8, 1).normalize();

  if (camera instanceof THREE.PerspectiveCamera) {
    const fov = (camera.fov * Math.PI) / 180;
    const distance = (maxDim / 2 / Math.tan(fov / 2)) * offset;
    camera.position.copy(center).add(direction.multiplyScalar(distance));
    camera.near = Math.max(distance / 1000, 0.001);
    camera.far = distance * 1000;
  } else {
    const aspect = (camera.right - camera.left) / (camera.top - camera.bottom) || 1;
    const halfV = (maxDim / 2) * offset;
    camera.top = halfV;
    camera.bottom = -halfV;
    camera.left = -halfV * aspect;
    camera.right = halfV * aspect;
    camera.zoom = 1;
    const distance = maxDim * 3 + 1; // depth only; ortho size is the frustum
    camera.position.copy(center).add(direction.multiplyScalar(distance));
    camera.near = 0.001;
    camera.far = distance * 100;
  }

  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}
