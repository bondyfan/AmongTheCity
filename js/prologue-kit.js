import * as THREE from 'three';

// Static architecture is instanced per finish, including the lit windows.
export function scenery(parent) {
  const batches = new Map(),
    signs = [],
    textures = [];
  const geometry = new THREE.BoxGeometry();
  const round = new THREE.SphereGeometry(0.5, 12, 8);
  const pose = new THREE.Object3D();
  function box(x, y, z, w, h, d, color, rz = 0, glow = false, surface = 'solid') {
    const key = color + '/' + glow + '/' + surface;
    if (!batches.has(key)) batches.set(key, { color, glow, surface, matrices: [] });
    pose.position.set(x, y, z);
    pose.scale.set(w, h, d);
    pose.rotation.set(0, 0, rz);
    pose.updateMatrix();
    batches.get(key).matrices.push(pose.matrix.clone());
  }
  function sign(x, y, z, width, height, lines, yaw = 0, bg = '#173957', ink = '#f4f4e7') {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = Math.max(72, Math.round((768 * height) / width));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const row = canvas.height / lines.length;
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.round(row * 0.62) + 'px system-ui, sans-serif';
    lines.forEach((line, i) => ctx.fillText(line, 384, (i + 0.5) * row, 730));
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map }));
    m.position.set(x, y, z);
    m.rotation.y = yaw;
    parent.add(m);
    signs.push(m);
    textures.push(map);
  }
  function finish() {
    for (const { color, glow, surface, matrices } of batches.values()) {
      const mat = glow ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshLambertMaterial({ color });
      if (surface === 'glass') {
        mat.transparent = true;
        mat.opacity = 0.16;
        mat.depthWrite = false;
      }
      if (!glow && surface !== 'glass') {
        // Metre-scaled grain and soft corner shading on otherwise uniform
        // surfaces. Local coordinates keep it fixed while the station moves.
        mat.onBeforeCompile = (shader) => {
          shader.vertexShader =
            'varying vec3 vLocal, vPlace;\n' +
            shader.vertexShader.replace(
              '#include <begin_vertex>',
              '#include <begin_vertex>\n vLocal=position; vPlace=(instanceMatrix*vec4(position,1.)).xyz;'
            );
          shader.fragmentShader =
            'varying vec3 vLocal, vPlace;\n' +
            shader.fragmentShader.replace(
              '#include <color_fragment>',
              `#include <color_fragment>
            vec3 a=abs(vLocal);
            float edge=min(max(a.x,a.y),min(max(a.y,a.z),max(a.z,a.x)));
            float grain=fract(sin(dot(floor(vPlace*28.),vec3(12.98,78.23,33.13)))*437.54);
            float lod=1.-smoothstep(.15,1.,length(fwidth(vPlace))*28.);
            diffuseColor.rgb *= (.90 + .12*vLocal.y + .09*edge + .09*grain*lod);
            `
            );
        };
      }
      const mesh = new THREE.InstancedMesh(surface === 'round' ? round : geometry, mat, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      parent.add(mesh);
    }
    batches.clear();
  }
  function dispose() {
    for (const m of parent.children) {
      m.material?.dispose();
      m.dispose?.();
    }
    for (const m of signs) m.geometry.dispose();
    for (const t of textures) t.dispose();
    round.dispose();
    geometry.dispose();
    parent.removeFromParent();
    parent.clear();
  }
  return { box, sign, finish, dispose };
}
