attribute float aAo;
attribute float aThickness;

varying vec3  vWorldPosition;
varying vec3  vWorldNormal;
varying vec3  vViewNormal;
varying vec3  vLocalPosition;
varying vec3  vLocalNormal;
varying float vAo;
varying float vThickness;

void main() {
  vLocalPosition = position;
  vLocalNormal   = normal;
  vAo            = aAo;
  vThickness     = aThickness;

  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;

  // instances are uniformly scaled, so the upper 3x3 is safe for normals
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vViewNormal  = normalize(normalMatrix * normal);

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
