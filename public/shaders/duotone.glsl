// Duotone: maps the layer's tones onto two colors. Effect.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @content */
uniform sampler2D u_content;
/** @label Shadows @color @default #1B1464 */
uniform vec3 u_dark;
/** @label Highlights @color @default #FF7A59 */
uniform vec3 u_light;
/** @label Contrast @default 0.2 @range -1, 1 */
uniform float u_contrast;
/** @label Amount @default 1 @range 0, 1 */
uniform float u_amount;

void main() {
  vec4 c = texture2D(u_content, gl_FragCoord.xy / u_resolution);
  vec3 rgb = c.rgb / max(c.a, 0.0001);
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  l = clamp((l - 0.5) * (1.0 + u_contrast) + 0.5, 0.0, 1.0);
  vec3 tone = mix(u_dark, u_light, smoothstep(0.0, 1.0, l));
  gl_FragColor = vec4(mix(rgb, tone, u_amount) * c.a, c.a);
}
