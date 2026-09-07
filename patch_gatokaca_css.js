const fs = require('fs');
let css = fs.readFileSync('gatokaca.css', 'utf8');

// Find start and end markers
const startMarker = '/* ===========================\n   TILES\n   =========================== */';
const endMarker = '/* ===========================\n   RIGHT PANEL - Gatokaca Hero\n   =========================== */';

const startIdx = css.indexOf(startMarker);
const endIdx   = css.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.error('Marker not found! start:', startIdx, 'end:', endIdx);
  process.exit(1);
}

const newTileCSS = `/* ===========================
   TILES
   =========================== */
.gato-tile {
  width: 92%; height: 92%;
  display: flex; align-items: center; justify-content: center;
  position: relative;
  transition: transform 0.15s;
  background: none; border: none; box-shadow: none;
}

/* Win glow */
.gato-tile-win::after {
  content: '';
  position: absolute; inset: -8%;
  border-radius: 50%;
  background: transparent;
  box-shadow: 0 0 2.5vh 1vh rgba(255,215,0,0.9);
  animation: tileWinPulse 0.5s ease-in-out infinite alternate;
  pointer-events: none; z-index: 10;
}
@keyframes tileWinPulse {
  0%   { box-shadow: 0 0 1.5vh 0.5vh rgba(255,215,0,0.7); }
  100% { box-shadow: 0 0 3.5vh 2vh rgba(255,215,0,1), 0 0 6vh 3vh rgba(255,150,0,0.6); }
}
.gato-tile-explode { animation: tileBlast 0.4s ease-out forwards; }
@keyframes tileBlast {
  0%   { transform: scale(1); opacity: 1; }
  40%  { transform: scale(1.3); filter: brightness(3) drop-shadow(0 0 1vh #ffd700); }
  100% { transform: scale(0); opacity: 0; }
}

/* ===========================
   8-POINT STAR GEM SYMBOLS
   =========================== */
.gato-sym-gem { background: none; border: none; box-shadow: none; }
.gato-star-wrap {
  width: 88%; height: 88%;
  position: relative;
  display: flex; align-items: center; justify-content: center;
}
.gato-star-sq {
  position: absolute; inset: 0;
  background: linear-gradient(135deg, #b8860b 0%, #ffd700 25%, #daa520 50%, #ffd740 75%, #b8860b 100%);
  border-radius: 12%;
  box-shadow: 0 0.3vh 0.8vh rgba(0,0,0,0.5), inset 0 0.2vh 0.3vh rgba(255,255,255,0.4);
}
.gato-star-sq0  { transform: rotate(0deg); }
.gato-star-sq45 { transform: rotate(45deg); }
/* Gold ring */
.gato-star-wrap::before {
  content: '';
  position: absolute; inset: 8%;
  border-radius: 50%;
  background: linear-gradient(135deg, #ffd700, #b8860b, #ffd700);
  z-index: 1;
}
.gato-gem-circle {
  position: absolute; inset: 15%;
  border-radius: 50%; z-index: 2;
  box-shadow: inset 0 0.3vh 0.5vh rgba(0,0,0,0.4), inset 0 -0.2vh 0.3vh rgba(255,255,255,0.2);
  overflow: hidden;
}
.gato-gem-hi {
  position: absolute; top: 8%; left: 10%;
  width: 38%; height: 38%;
  background: rgba(255,255,255,0.85);
  border-radius: 50%; filter: blur(1.5px);
}
.gato-gem-lo { position: absolute; inset: 0; border-radius: 50%; }

/* ===========================
   SCATTER (Gatokaca Face)
   =========================== */
.gato-sym-scatter { background: none; border: none; box-shadow: none; }
.gato-scatter-bg {
  width: 88%; height: 88%;
  background: linear-gradient(160deg, #1a237e 0%, #283593 35%, #3949ab 65%, #1a237e 100%);
  border: 0.35vh solid #ffd700;
  border-radius: 1vh;
  box-shadow: 0 0 2vh rgba(255,215,0,0.5), inset 0 0.2vh 0.3vh rgba(255,255,255,0.15);
  display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
  padding: 4% 5% 3%;
  position: relative; overflow: hidden;
  gap: 3%;
}
.gato-sc-gold-frame {
  position: absolute; inset: 0.2vh;
  border: 0.15vh solid rgba(255,215,0,0.35);
  border-radius: 0.8vh; pointer-events: none;
}
.gato-sc-crown {
  width: 55%; height: 18%;
  background: linear-gradient(180deg, #ffd700 0%, #ff8f00 60%, #b8860b 100%);
  clip-path: polygon(0% 100%, 5% 40%, 20% 80%, 35% 0%, 50% 60%, 65% 0%, 80% 80%, 95% 40%, 100% 100%);
  flex-shrink: 0;
}
.gato-sc-face {
  width: 60%; aspect-ratio: 1;
  background: radial-gradient(circle at 40% 35%, #a1887f 0%, #6d4c41 55%, #3e2723 100%);
  border-radius: 45% 45% 38% 38%;
  border: 0.12vh solid #b8860b;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4%; flex-shrink: 0;
}
.gato-sc-eyes { display: flex; gap: 16%; }
.gato-sc-eye {
  width: 24%; aspect-ratio: 1;
  background: radial-gradient(circle, #ffcc02 0%, #e65100 40%, #1a1a1a 100%);
  border-radius: 50%;
  box-shadow: 0 0 0.4vh rgba(255,200,0,0.9);
}
.gato-sc-nose {
  width: 28%; height: 10%;
  background: #3e2723; border-radius: 40% 40% 50% 50%;
}
.gato-sc-beard {
  width: 65%; height: 14%;
  background: linear-gradient(180deg, #4e342e, #212121);
  border-radius: 0 0 40% 40%;
}
.gato-scatter-label {
  background: linear-gradient(90deg, #ffd700, #ff8f00, #ffd700);
  color: #1a0000; font-size: clamp(0.45rem, 1.1vh, 1.3vh);
  font-weight: 900; padding: 1% 8%; border-radius: 0.3vh;
  letter-spacing: 0.04em; flex-shrink: 0;
}

/* ===========================
   HIGH VALUE FRAME (shared)
   =========================== */
.gato-sym-hv { background: none; border: none; box-shadow: none; }
.gato-hv-frame {
  width: 88%; height: 88%;
  background: linear-gradient(135deg, #3b2000 0%, #6d4c00 30%, #3b2000 65%, #5d3800 100%);
  border: 0.3vh solid #ffd700;
  border-radius: 1vh;
  box-shadow: 0 0 2vh rgba(255,200,0,0.4), inset 0 0.2vh 0.3vh rgba(255,255,255,0.2);
  display: flex; align-items: center; justify-content: center;
  position: relative; overflow: hidden;
}
.gato-hv-frame::before {
  content: '';
  position: absolute; inset: 0.2vh;
  border: 0.1vh solid rgba(255,215,0,0.3);
  border-radius: 0.7vh;
}
/* LAMP */
.gato-lamp {
  width: 75%; height: 80%; position: relative;
  display: flex; align-items: flex-end; justify-content: center;
}
.gato-lamp-body {
  position: absolute; bottom: 8%; left: 12%; right: 12%; height: 55%;
  background: radial-gradient(ellipse at 40% 35%, #fff9c4 0%, #ffd740 40%, #ff8f00 80%, #b8860b 100%);
  border-radius: 40% 40% 30% 30%; border: 0.12vh solid #b8860b;
}
.gato-lamp-spout {
  position: absolute; top: 18%; right: 3%; width: 38%; height: 22%;
  background: linear-gradient(90deg, #ffd740, #b8860b);
  border-radius: 50% 80% 80% 50%; border: 0.1vh solid #b8860b;
}
.gato-lamp-handle {
  position: absolute; top: 10%; left: 3%; width: 28%; height: 35%;
  border: 0.3vh solid #ffd700; border-radius: 50%;
  border-right-color: transparent; border-bottom-color: transparent;
}
.gato-lamp-flame {
  position: absolute; top: 0; left: 38%; width: 24%; height: 28%;
  background: radial-gradient(ellipse at 50% 80%, #fff176 0%, #ffb300 50%, #e65100 100%);
  border-radius: 50% 50% 40% 40%;
  animation: flameDance 0.8s ease-in-out infinite alternate;
}
@keyframes flameDance {
  0%   { transform: scaleX(1) skewX(0deg); }
  100% { transform: scaleX(0.8) skewX(8deg); }
}
/* LION */
.gato-lion {
  width: 72%; height: 78%; position: relative;
}
.gato-lion-mane {
  position: absolute; top: 4%; left: 8%; right: 8%; height: 52%;
  background: radial-gradient(ellipse, #ffd740 0%, #ff8f00 50%, #b8860b 100%);
  border-radius: 50%; border: 0.12vh solid #b8860b;
}
.gato-lion-head {
  position: absolute; top: 12%; left: 22%; right: 22%; height: 38%;
  background: radial-gradient(ellipse at 40% 35%, #fff9c4 0%, #ffd740 40%, #ff8f00 80%);
  border-radius: 50%; border: 0.1vh solid #b8860b;
}
.gato-lion-body2 {
  position: absolute; bottom: 6%; left: 14%; right: 14%; height: 40%;
  background: linear-gradient(180deg, #ffd740 0%, #b8860b 100%);
  border-radius: 20% 20% 10% 10%; border: 0.1vh solid #b8860b;
}
.gato-lion-paw {
  position: absolute; bottom: 1%; left: 25%; right: 25%; height: 10%;
  background: linear-gradient(180deg, #ffd740, #b8860b);
  border-radius: 30%; border: 0.1vh solid #b8860b;
}
/* CRYSTAL */
.gato-crystal {
  width: 55%; height: 82%; position: relative;
  display: flex; align-items: center; justify-content: center;
}
.gato-crystal-top {
  position: absolute; top: 0; left: 20%; right: 20%; height: 30%;
  background: linear-gradient(180deg, #e3f2fd 0%, #29b6f6 60%, #0288d1 100%);
  clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
  filter: drop-shadow(0 0 0.5vh rgba(41,182,246,0.8));
}
.gato-crystal-body {
  position: absolute; top: 25%; left: 5%; right: 5%; bottom: 0;
  background: linear-gradient(135deg, #b3e5fc 0%, #29b6f6 40%, #0288d1 70%, #01579b 100%);
  clip-path: polygon(20% 0%, 80% 0%, 100% 100%, 0% 100%);
  border: 0.1vh solid #0288d1;
}
.gato-crystal-shine {
  position: absolute; top: 30%; left: 15%; width: 20%; height: 40%;
  background: rgba(255,255,255,0.65);
  clip-path: polygon(30% 0%, 70% 0%, 40% 100%, 0% 100%);
  filter: blur(1px);
}

/* ===========================
   MULTIPLIER ORB
   =========================== */
.gato-mult-orb {
  width: 88%; height: 88%;
  border-radius: 50%;
  border: 0.3vh solid rgba(255,255,255,0.45);
  display: flex; align-items: center; justify-content: center;
  position: relative; overflow: hidden;
  animation: multOrbPulse 1.8s ease-in-out infinite;
}
@keyframes multOrbPulse {
  0%,100% { filter: brightness(1); }
  50%     { filter: brightness(1.3) drop-shadow(0 0 0.8vh rgba(150,220,255,1)); }
}
.gato-mult-lightning {
  position: absolute; inset: 0;
  background:
    radial-gradient(circle at 28% 22%, rgba(255,255,255,0.75) 0%, transparent 42%),
    radial-gradient(circle at 72% 72%, rgba(255,255,255,0.18) 0%, transparent 38%);
  border-radius: 50%;
}
.gato-mult-val {
  color: #fff; font-size: clamp(0.75rem, 2.4vh, 2.8vh);
  font-weight: 900; letter-spacing: -0.03em;
  text-shadow: 0 0.1vh 0.4vh rgba(0,0,0,0.95), 0 0 0.8vh rgba(0,0,0,0.7);
  position: relative; z-index: 1;
}

`;

css = css.slice(0, startIdx) + newTileCSS + '\n' + css.slice(endIdx);
fs.writeFileSync('gatokaca.css', css, 'utf8');
console.log('Done! Lines:', css.split('\n').length);
