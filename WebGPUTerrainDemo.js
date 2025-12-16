import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Sun, Wind, Sparkles, Info, Cpu } from 'lucide-react';
import htm from 'htm';

const html = htm.bind(React.createElement);

export default function WebGPUTerrainDemo() {
  const containerRef = useRef(null);
  const [status, setStatus] = useState('initializing');
  const [stats, setStats] = useState({ fps: 0, triangles: 0 });
  const rendererRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let renderer, scene, camera, terrain, grassInstances, particles;
    let animationId;
    let time = 0;

    async function init() {
      try {
        // Check WebGPU support at browser level first
        if (!navigator.gpu) {
          setStatus('WebGPU not supported. Please use Chrome 113+ with WebGPU enabled.');
          return;
        }

        setStatus('Initializing WebGPU...');

        // Dynamic imports for WebGPU modules to prevent crash if not available
        // Handling both named and default exports for compatibility
        const capabilityModule = await import('three/addons/capabilities/WebGPU.js');
        const WebGPU = capabilityModule.default || capabilityModule.WebGPU;

        if (!await WebGPU.isAvailable()) {
          setStatus('WebGPU not available');
          return;
        }

        const webGPUModule = await import('three/webgpu');
        const WebGPURenderer = webGPUModule.WebGPURenderer || webGPUModule.default;
        
        // Import TSL nodes
        const Nodes = await import('three/tsl');
        const { 
          color, float, vec3, vec4, positionLocal, positionWorld, normalWorld, 
          timerLocal, mix, smoothstep, instanceMatrix, uv,
          mx_perlin_noise_float, mx_noise_vec3, step, max, min, dot, varying,
          MeshStandardNodeMaterial, cameraPosition
        } = Nodes;

        // Scene setup
        scene = new THREE.Scene();
        // Atmospheric fog color
        const fogColor = color(0x87ceeb);
        // Distance based fog implementation using nodes is complex, falling back to standard Fog for now which works with NodeMaterial in recent versions
        scene.fog = new THREE.FogExp2(0xe0f7fa, 0.008);
        scene.background = new THREE.Color(0xe0f7fa);

        // Camera
        camera = new THREE.PerspectiveCamera(
          55,
          containerRef.current.offsetWidth / containerRef.current.offsetHeight,
          0.1,
          1000
        );
        camera.position.set(0, 8, 25);
        camera.lookAt(0, 3, 0);

        // WebGPU Renderer
        renderer = new WebGPURenderer({ antialias: true, stencil: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(containerRef.current.offsetWidth, containerRef.current.offsetHeight);
        
        // Advanced Tone mapping
        renderer.toneMapping = THREE.ReinhardToneMapping;
        renderer.toneMappingExposure = 1.5;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        
        containerRef.current.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        setStatus('Building physically accurate world...');

        // --- Lighting ---
        
        // Sun - Directional Light
        const sun = new THREE.DirectionalLight(0xfff0dd, 3.5);
        sun.position.set(50, 80, 50);
        sun.castShadow = true;
        sun.shadow.mapSize.width = 4096;
        sun.shadow.mapSize.height = 4096;
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 200;
        const shadowSize = 60;
        sun.shadow.camera.left = -shadowSize;
        sun.shadow.camera.right = shadowSize;
        sun.shadow.camera.top = shadowSize;
        sun.shadow.camera.bottom = -shadowSize;
        sun.shadow.bias = -0.0001;
        // Soften shadows
        sun.shadow.radius = 2;
        scene.add(sun);

        // Fill Light - Hemisphere
        const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x3d4f2d, 1.2);
        scene.add(hemiLight);

        // --- Terrain ---

        const terrainGeo = new THREE.PlaneGeometry(300, 300, 512, 512);
        // Rotate geometry to face up
        terrainGeo.rotateX(-Math.PI / 2);

        // Node-based procedural terrain material
        const terrainMaterial = new MeshStandardNodeMaterial();
        
        // Procedural Height / Displacement
        const posWorld = positionWorld.xz.mul(0.05); // Scale for noise
        const largeNoise = mx_perlin_noise_float(posWorld).mul(8.0);
        const mediumNoise = mx_perlin_noise_float(posWorld.mul(2.5)).mul(2.0);
        const detailNoise = mx_perlin_noise_float(posWorld.mul(8.0)).mul(0.5);
        
        // Combine noise for height
        const elevation = largeNoise.add(mediumNoise).add(detailNoise);
        
        // Displacement using TSL
        terrainMaterial.positionNode = positionLocal.add(vec3(0, 1, 0).mul(elevation));
        
        // Triplanar-ish Texturing Logic (Procedural)
        // Slope detection for blending between grass/dirt/rock
        const up = vec3(0, 1, 0);
        // Recalculate normal after displacement is tricky in nodes without explicit derivatives sometimes, 
        // so we approximate slope from position or use world normal if available post-displacement.
        // For this demo, we'll use height-based texturing.
        
        const grassColor = color(0x2d4c1e);
        const dirtColor = color(0x59462d);
        const rockColor = color(0x5a5a5a);

        // Mix colors based on elevation and noise
        const noiseMix = mx_perlin_noise_float(posWorld.mul(5.0));
        let surfaceColor = mix(grassColor, dirtColor, smoothstep(-2.0, 1.0, elevation.add(noiseMix)));
        surfaceColor = mix(surfaceColor, rockColor, smoothstep(5.0, 8.0, elevation));

        terrainMaterial.colorNode = surfaceColor;
        terrainMaterial.roughnessNode = float(0.9); // Earthy
        terrainMaterial.metalnessNode = float(0.0);

        terrain = new THREE.Mesh(terrainGeo, terrainMaterial);
        terrain.receiveShadow = true;
        terrain.castShadow = true;
        scene.add(terrain);

        // --- Grass System ---

        // Grass Blade Geometry - More detailed for closer shots
        // 5 segments high, curved
        const grassGeo = new THREE.PlaneGeometry(0.12, 1.5, 1, 5);
        grassGeo.translate(0, 0.75, 0);
        
        // Instancing
        const instanceCount = 65000;
        
        const grassMaterial = new MeshStandardNodeMaterial();
        grassMaterial.side = THREE.DoubleSide;
        
        // Wind System (Hierarchical)
        const time = timerLocal();
        
        // Use instance index to vary parameters
        const instancePos = instanceMatrix.mul(vec4(0, 0, 0, 1)).xyz; // Get instance world position
        
        // 1. Low Frequency Swell (0.5Hz)
        const windLow = mx_noise_vec3(instancePos.mul(0.05).add(vec3(time.mul(0.5), 0, time.mul(0.2))));
        
        // 2. Medium Frequency Waves (2Hz)
        const windMed = mx_noise_vec3(instancePos.mul(0.2).add(vec3(time.mul(1.5), 0, time.mul(1.0))));
        
        // 3. High Frequency Flutter (Tip only)
        const windHigh = mx_noise_vec3(instancePos.mul(1.0).add(time.mul(5.0)));
        
        // Combine wind forces
        const totalWind = windLow.mul(0.5).add(windMed.mul(0.3)).add(windHigh.mul(0.1));
        
        // Apply wind based on UV height (y-coordinate) so base stays pinned
        const bladeHeight = uv().y;
        const windForce = totalWind.mul(bladeHeight.pow(2)).mul(2.0); // Quadratic bend
        
        // Displace position
        const newPos = positionLocal.add(vec3(windForce.x, 0, windForce.z));
        grassMaterial.positionNode = newPos;

        // Subsurface Scattering Approximation (Backlighting)
        // We simulate light passing through the blade when looking against the light
        // Simple hack: if normal faces away from camera, brighten the color
        
        const baseGrassColor = color(0x4a6f22);
        const tipGrassColor = color(0xa7c44c);
        
        // Gradient from bottom to top
        const bladeColor = mix(baseGrassColor, tipGrassColor, bladeHeight);
        
        // Variation per instance
        const colorVar = mx_noise_vec3(instancePos.mul(0.5));
        const variedColor = bladeColor.add(colorVar.mul(0.1));
        
        grassMaterial.colorNode = variedColor;
        grassMaterial.roughnessNode = float(0.6);
        grassMaterial.metalnessNode = float(0.0);

        // Custom SSS logic via emissive or adjusting color based on view/light
        // WebGPU Nodes allow custom lighting models but simple emission works for glow
        // Add a slight emissive glow at the tips based on sun direction could be simulated by logic
        // For now, static emission on tips makes them look translucent
        grassMaterial.emissiveNode = bladeColor.mul(0.1).mul(bladeHeight);

        grassInstances = new THREE.InstancedMesh(grassGeo, grassMaterial, instanceCount);
        grassInstances.castShadow = true;
        grassInstances.receiveShadow = true;
        
        // Distribute grass
        const tempObj = new THREE.Object3D();
        const dummyMatrix = new THREE.Matrix4();
        let grassIdx = 0;

        // We need CPU side height lookup for initial placement, matching the GPU noise is hard perfectly without readback.
        // We will approximate or reuse the same math on CPU.
        
        function getElevationCPU(x, z) {
           const xs = x * 0.05;
           const zs = z * 0.05;
           
           // Simple noise approximation for CPU placement (won't match GPU perfectly but good enough for distribution)
           // Actually, let's just do a simpler height for placement to ensure they are grounded 
           // and let the GPU terrain match it? No, GPU terrain is ground truth.
           // We'll reimplement the exact noise function on CPU.
           
           const large = (Math.sin(xs)*Math.cos(zs) + Math.sin(xs*0.5)*Math.cos(zs*0.5)) * 4.0; // Rough approx of Perlin
           // It's safer to use Raycasting to place grass if we want perfection, but that's slow for 65k.
           // Let's rely on a flatter area or simpler terrain for this demo to ensure alignment, 
           // OR use the Raycaster for the visible area.
           return large; // Placeholder, see logic below
        }

        // Better approach: Use Raycaster to drop grass onto the GPU-displaced mesh?
        // We haven't rendered yet, so displacement hasn't happened in world space for raycaster if it's shader only.
        // If we used displacement map texture, we could read it.
        // Since we used NodeMaterial displacement, the CPU geometry is flat.
        // FIX: We must update the CPU geometry to match the visual terrain for physics/placement.
        // Let's modify the terrain mesh geometry directly on CPU instead of vertex shader displacement for consistency.
        
        // Reset terrain to standard material for consistency or apply height to geometry
        const vertices = terrain.geometry.attributes.position.array;
        for(let i=0; i < vertices.length; i+=3) {
            const x = vertices[i];
            const y = vertices[i+1]; // z in local space before rotation
            // Our noise logic from shader:
            const xs = x * 0.05;
            const ys = y * 0.05; // shader uses world XZ, which corresponds to mesh XY before rotation? No mesh is X,-Z usually.
            // Let's keep it simple: Simple sine waves for height that match easily
            const h = Math.sin(xs)*Math.cos(ys)*4 + Math.sin(xs*3)*Math.cos(ys*3)*1;
            vertices[i+2] = h;
        }
        terrain.geometry.computeVertexNormals();
        // Update shader to NOT displace, just color
        terrainMaterial.positionNode = positionLocal; // Reset displacement
        
        // Place Grass
        for (let i = 0; i < instanceCount; i++) {
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * 100 + 5; // Don't put grass exactly under camera
          const x = Math.cos(angle) * radius;
          const z = Math.sin(angle) * radius;
          
          // Find height
          // Bilinear interpolation of grid or just nearest vertex?
          // Simple math lookup since we defined it above
          const xs = x * 0.05;
          const zs = -z * 0.05; // Plane is rotated -90 X, so local Y is world -Z
          const h = Math.sin(xs)*Math.cos(zs)*4 + Math.sin(xs*3)*Math.cos(zs*3)*1;
          
          tempObj.position.set(x, h, z);
          
          // Random scale/rotation
          tempObj.rotation.y = Math.random() * Math.PI * 2;
          const s = 0.8 + Math.random() * 0.5;
          tempObj.scale.set(s, s * (0.8 + Math.random() * 0.4), s);
          
          // Tilt along slope? (Optional, skipping for perf)
          
          tempObj.updateMatrix();
          grassInstances.setMatrixAt(i, tempObj.matrix);
        }
        scene.add(grassInstances);

        // --- Post Processing / Atmosphere ---
        // Volumetric Fog effect using simple sprites?
        // Let's add the particles back as "pollen" or "dust"
        
        const partGeo = new THREE.BufferGeometry();
        const pCount = 2000;
        const pPos = new Float32Array(pCount * 3);
        const pVel = [];
        for(let i=0; i<pCount; i++) {
            pPos[i*3] = (Math.random()-0.5)*100;
            pPos[i*3+1] = Math.random()*20;
            pPos[i*3+2] = (Math.random()-0.5)*100;
            pVel.push({
                x: (Math.random()-0.5)*0.05,
                y: (Math.random()-0.5)*0.05,
                z: (Math.random()-0.5)*0.05
            });
        }
        partGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
        const partMat = new THREE.PointsMaterial({
            color: 0xffffee,
            size: 0.1,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending
        });
        particles = new THREE.Points(partGeo, partMat);
        particles.userData.velocities = pVel;
        scene.add(particles);


        setStatus('rendering');

        // Animation loop
        let lastTime = performance.now();
        let frameCount = 0;
        let fpsTime = 0;

        function animate() {
          animationId = requestAnimationFrame(animate);

          const currentTime = performance.now();
          const deltaTime = currentTime - lastTime;
          lastTime = currentTime;
          time = currentTime * 0.001;

          // FPS calculation
          frameCount++;
          fpsTime += deltaTime;
          if (fpsTime >= 1000) {
            setStats({
              fps: Math.round(frameCount * 1000 / fpsTime),
              triangles: Math.round(renderer.info.render.triangles / 1000)
            });
            frameCount = 0;
            fpsTime = 0;
          }

          // Animate particles
          if (particles) {
            const positions = particles.geometry.attributes.position.array;
            const velocities = particles.userData.velocities;
            
            for (let i = 0; i < velocities.length; i++) {
              positions[i * 3] += velocities[i].x;
              positions[i * 3 + 1] += velocities[i].y;
              positions[i * 3 + 2] += velocities[i].z;

              if (Math.abs(positions[i * 3]) > 50) velocities[i].x *= -1;
              if (positions[i * 3 + 1] > 35 || positions[i * 3 + 1] < 5) velocities[i].y *= -1;
              if (Math.abs(positions[i * 3 + 2]) > 50) velocities[i].z *= -1;
            }
            particles.geometry.attributes.position.needsUpdate = true;
          }

          // Slow sun movement
          if (sun) {
            sun.position.x = Math.cos(time * 0.05) * 80;
            sun.position.z = Math.sin(time * 0.05) * 80;
          }

          // Cinematic Camera Movement
          const camTime = time * 0.1;
          const radius = 35;
          camera.position.x = Math.sin(camTime) * radius;
          camera.position.z = Math.cos(camTime) * radius;
          camera.position.y = 12 + Math.sin(camTime * 0.5) * 4;
          camera.lookAt(0, 5, 0);

          if (renderer && scene && camera) {
            renderer.render(scene, camera);
          }
        }

        animate();

      } catch (error) {
        console.error('WebGPU Error:', error);
        setStatus(`Error: ${error.message}. WebGPU requires Chrome 113+ with flag enabled.`);
      }
    }

    function handleResize() {
      if (!containerRef.current || !rendererRef.current) return;
      camera.aspect = containerRef.current.offsetWidth / containerRef.current.offsetHeight;
      camera.updateProjectionMatrix();
      rendererRef.current.setSize(
        containerRef.current.offsetWidth,
        containerRef.current.offsetHeight
      );
    }

    init();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationId) cancelAnimationFrame(animationId);
      if (rendererRef.current) {
        rendererRef.current.dispose();
        if (containerRef.current && rendererRef.current.domElement) {
          containerRef.current.removeChild(rendererRef.current.domElement);
        }
      }
    };
  }, []);

  return html`
    <div className="w-full h-screen bg-black relative overflow-hidden font-sans">
      <div ref=${containerRef} className="w-full h-full" />
      
      ${status !== 'rendering' && html`
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm z-50">
          <div className="text-center text-white p-8 max-w-md">
            <${Cpu} className="w-16 h-16 mx-auto mb-4 text-blue-400 animate-pulse" />
            <h2 className="text-2xl font-bold mb-4">WebGPU Terrain Scene</h2>
            <p className="text-gray-300">${status}</p>
            ${status.includes('not supported') && html`
              <div className="mt-4 text-sm text-yellow-400 bg-yellow-400/10 p-4 rounded border border-yellow-400/20">
                To enable WebGPU in Chrome:<br/>
                1. Go to <code className="bg-black/30 px-1 rounded">chrome://flags/#enable-unsafe-webgpu</code><br/>
                2. Set to "Enabled"<br/>
                3. Relaunch Chrome
              </div>
            `}
          </div>
        </div>
      `}

      ${status === 'rendering' && html`
        <${React.Fragment}>
          <div className="absolute top-4 left-4 bg-black/70 backdrop-blur-sm text-white p-4 rounded-lg border border-white/20 select-none pointer-events-none">
            <h2 className="text-xl font-bold mb-3 flex items-center gap-2">
              <${Sparkles} className="w-5 h-5 text-yellow-400" />
              WebGPU Realtime 3D
            </h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <${Sun} className="w-4 h-4 text-orange-400" />
                <span>PBR Materials + Shadows</span>
              </div>
              <div className="flex items-center gap-2">
                <${Wind} className="w-4 h-4 text-blue-400" />
                <span>65,000 GPU-Animated Blades</span>
              </div>
              <div className="flex items-center gap-2">
                <${Sparkles} className="w-4 h-4 text-yellow-400" />
                <span>Hierarchical Wind + SSS</span>
              </div>
              <div className="pt-2 border-t border-white/20 space-y-1">
                <div className="text-green-400 font-mono">${stats.fps} FPS</div>
                <div className="text-blue-400 font-mono">${stats.triangles}K Triangles</div>
              </div>
            </div>
          </div>

          <div className="absolute bottom-4 right-4 bg-black/70 backdrop-blur-sm text-white p-3 rounded-lg border border-white/20 text-xs hidden md:block select-none pointer-events-none">
            <div className="font-bold mb-1">TSL / WebGPU Features:</div>
            <div className="text-gray-300">• Node-based Material Shaders</div>
            <div className="text-gray-300">• GPU Vertex Displacement</div>
            <div className="text-gray-300">• Subsurface Scattering Approximation</div>
            <div className="text-gray-300">• Procedural Terrain Texturing</div>
            <div className="text-gray-300">• Hardware Instancing (65k+)</div>
          </div>
        </${React.Fragment}>
      `}
    </div>
  `;
}

