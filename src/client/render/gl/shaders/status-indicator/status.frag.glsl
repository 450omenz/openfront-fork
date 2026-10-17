#version 300 es
precision highp float;

uniform vec3 uColor[8];
uniform vec4 uParams[8];  // size, offsetY, shape (0 badge, 1 ring), pulseHz
uniform float uTime;      // seconds

in vec2 vLocal;
flat in int vIndex;

out vec4 fragColor;

const float TAU = 6.2831853;

void main() {
  vec3 color = uColor[vIndex];
  vec4 p = uParams[vIndex];
  float r = length(vLocal);

  if (p.z < 0.5) {
    // Badge: dark-rimmed blinking disc with a white "!" (y grows downward).
    if (r > 1.0) discard;
    float blink = 0.7 + 0.3 * sin(uTime * TAU * p.w);
    vec3 col = r > 0.8 ? vec3(0.06) : color * blink;
    bool isBar = abs(vLocal.x) < 0.14 && vLocal.y > -0.58 && vLocal.y < 0.16;
    bool isDot = length(vLocal - vec2(0.0, 0.42)) < 0.15;
    if ((isBar || isDot) && r <= 0.8) col = vec3(1.0);
    float edge = 1.0 - smoothstep(0.92, 1.0, r);
    fragColor = vec4(col, edge);
    return;
  }

  // Ring: expands outward and fades, repeating at pulseHz.
  float phase = fract(uTime * p.w);
  float radius = 0.35 + 0.6 * phase;
  float d = abs(r - radius);
  const float width = 0.09;
  if (d > width) discard;
  float alpha = (1.0 - phase) * 0.85 * (1.0 - d / width);
  fragColor = vec4(color, alpha);
}
