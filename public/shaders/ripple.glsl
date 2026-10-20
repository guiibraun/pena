// Water: rippling water over whatever is behind the shape. Fill, animated.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/** @backdrop */
uniform sampler2D u_backdrop;
/** @label Amplitude @default 6 @range 0, 40 */
uniform float u_amplitude;
/** @label Wave size @default 60 @range 10, 400 */
uniform float u_scale;
/** @label Speed @default 1 @range 0, 5 */
uniform float u_speed;
/** @label Highlights @default 0.35 @range 0, 1.5 */
uniform float u_shine;
/** @label Water @color @default #2A6F9733 */
uniform vec4 u_tint;

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 grad = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    float a = float(k) * 2.39996 + 0.7;
    vec2 dir = vec2(cos(a), sin(a));
    float f = 6.2831853 / (u_scale * (1.0 + 0.37 * float(k)));
    grad += cos(dot(p, dir) * f + u_time * u_speed * (1.3 + 0.4 * float(k))) * f * dir;
  }
  vec3 rgb = texture2D(u_backdrop, (p + grad * u_amplitude * u_scale * 0.25) / u_resolution).rgb;
  rgb = mix(rgb, u_tint.rgb, u_tint.a);
  vec3 n = normalize(vec3(-grad * u_scale * 0.15, 1.0));
  rgb += pow(max(dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.0), 40.0) * u_shine;
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
