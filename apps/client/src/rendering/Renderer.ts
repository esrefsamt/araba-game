import * as THREE from 'three';

const MAX_PIXEL_RATIO = 2;

export class Renderer {
  public readonly instance: THREE.WebGLRenderer;

  public constructor(container: HTMLElement) {
    this.instance = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.instance.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.instance.setSize(window.innerWidth, window.innerHeight);
    this.instance.outputColorSpace = THREE.SRGBColorSpace;
    this.instance.toneMapping = THREE.ACESFilmicToneMapping;
    this.instance.toneMappingExposure = 1.05;
    this.instance.shadowMap.enabled = true;
    this.instance.shadowMap.type = THREE.PCFShadowMap;
    container.append(this.instance.domElement);
  }

  public resize(width: number, height: number): void {
    this.instance.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.instance.setSize(width, height, false);
  }

  public render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.instance.render(scene, camera);
  }

  public dispose(): void {
    this.instance.dispose();
    this.instance.domElement.remove();
  }
}
