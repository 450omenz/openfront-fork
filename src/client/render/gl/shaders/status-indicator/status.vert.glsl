#version 300 es
precision highp float;

// Per-unit status indicators (fork). One instance per (unit, indicator).

layout(location = 0) in vec2 aPos;       // unit quad [0,1]x[0,1]
layout(location = 1) in vec4 aInstData;  // tile x, tile y, registry index, unit scale (0 = structure)

uniform mat3 uCamera;
uniform vec4 uParams[8];  // per registry entry: size, offsetY, shape, pulseHz
uniform float uScreenScale; // zoom-clamped unit scale (UnitScale.ts)

out vec2 vLocal;          // [-1,1]^2 across the indicator quad
flat out int vIndex;

void main() {
  vIndex = int(aInstData.z + 0.5);
  vec4 p = uParams[vIndex];
  // Indicators on units follow the sprite's size; structures stay fixed.
  float s = aInstData.w > 0.0 ? aInstData.w * uScreenScale : 1.0;
  float halfSize = p.x * s;
  // Rings use size as a radius, badges as a diameter.
  if (p.z < 0.5) halfSize *= 0.5;
  vec2 center = vec2(aInstData.x + 0.5, aInstData.y + 0.5 + p.y * s);
  vLocal = aPos * 2.0 - 1.0;
  vec2 worldPos = center + vLocal * halfSize;
  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
