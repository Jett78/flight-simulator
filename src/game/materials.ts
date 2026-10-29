import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

/** Small helper so every mesh gets a consistently-named flat material. */
export function createMaterial(
  scene: Scene,
  name: string,
  r: number,
  g: number,
  b: number,
  options?: { specular?: number; alpha?: number; emissive?: [number, number, number] },
): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = new Color3(r, g, b);
  mat.specularColor = new Color3(
    options?.specular ?? 0.15,
    options?.specular ?? 0.15,
    options?.specular ?? 0.15,
  );
  if (options?.emissive) {
    mat.emissiveColor = new Color3(...options.emissive);
  }
  if (options?.alpha !== undefined) {
    mat.alpha = options.alpha;
  }
  return mat;
}
