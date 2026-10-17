#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;        // unit quad [0,1]x[0,1]
layout(location = 1) in vec4 aInstData;   // x, y, progress, unit scale (0 = structure)

uniform mat3 uCamera;
uniform vec2 uBarSize;     // (width, height) in world tiles
uniform vec2 uBarOffset;   // offset from unit center in tiles
uniform float uSolid;      // 1.0 = veterancy pip mode (aInstData.z is a stack slot)
uniform float uPipStride;  // vertical spacing between stacked pips, in tiles
uniform float uScreenScale; // zoom-clamped unit scale (UnitScale.ts)

out vec2 vLocalPos;        // [0, barWidth] x [0, barHeight]
flat out float vProgress;

void main() {
  float worldX = aInstData.x;
  float worldY = aInstData.y;
  vProgress = aInstData.z;

  // Bars on units follow the sprite's size (fork); structure bars stay fixed.
  float s = aInstData.w > 0.0 ? aInstData.w * uScreenScale : 1.0;

  vec2 center = vec2(worldX + 0.5, worldY + 0.5);
  vec2 offset = uBarOffset;
  // In pip mode each instance is one stacked rank bar; raise it by its slot.
  offset.y -= uSolid * aInstData.z * uPipStride;
  vec2 barOrigin = center + offset * s;
  vec2 worldPos = barOrigin + aPos * uBarSize * s;

  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  vLocalPos = aPos * uBarSize;
}
