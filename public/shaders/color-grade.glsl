// Color grade: exposure, contrast, saturation, white balance and vignette. Effect.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @content */
uniform sampler2D u_content;
/** @label Exposure @default 0 @range -2, 2 */
uniform float u_exposure;
/** @label Contrast @default 0 @range -1, 1 */
uniform float u_contrast;
/** @label Saturation @default 0 @range -1, 1 */
uniform float u_saturation;
/** @label Temperature @default 0 @range -1, 1 */
uniform float u_temperature;
/** @label Tint @default 0 @range -1, 1 */
uniform float u_tint;
/** @label Vignette @default 0 @range 0, 1 */
uniform float u_vignette;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec4 c = texture2D(u_content, uv);
  vec3 rgb = c.rgb / max(c.a, 0.0001);
  rgb *= exp2(u_exposure);
  rgb *= vec3(1.0 + 0.2 * u_temperature, 1.0 - 0.15 * u_tint, 1.0 - 0.2 * u_temperature);
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, 1.0 + u_saturation);
  rgb = (rgb - 0.5) * (1.0 + u_contrast) + 0.5;
  rgb *= 1.0 - u_vignette * smoothstep(0.3, 1.0, length(uv - 0.5) * 1.414);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a);
}
