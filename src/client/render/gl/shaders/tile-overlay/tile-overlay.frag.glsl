#version 300 es
precision highp float;
precision highp usampler2D;

// Fork: per-tile overlay (population density, climate). uIndex holds one
// palette index per tile; 0 means "nothing here" and draws nothing.
uniform usampler2D uIndex;
uniform sampler2D uPalette;
uniform float uOpacity;

in vec2 vWorldPos;
out vec4 fragColor;

void main() {
  ivec2 tile = ivec2(floor(vWorldPos));
  uint idx = texelFetch(uIndex, tile, 0).r;
  if (idx == 0u) discard;
  vec4 c = texelFetch(uPalette, ivec2(int(idx), 0), 0);
  fragColor = vec4(c.rgb, c.a * uOpacity);
}
