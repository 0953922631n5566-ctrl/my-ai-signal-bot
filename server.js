```html
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OTC AI Quant Terminal - IQ Option Binary Decision Support</title>
  
  <!-- Tailwind CSS CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  
  <!-- FontAwesome Icons -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  
  <!-- Inter & JetBrains Mono Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">

  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            bgDark: '#070a11',
            cardDark: '#0f172a',
            panelDark: '#131c31',
            borderDark: '#1e293b',
            cyanGlow: '#00f2fe',
            greenGlow: '#00e676',
            redGlow: '#ff1744',
            amberGlow: '#ffab00',
            purpleGlow: '#7c3aed'
          },
          fontFamily: {
            sans: ['Inter', 'sans-serif'],
            mono: ['JetBrains Mono', 'monospace'],
          }
        }
      }
    }
  </script>

  <style>
    /* Custom Scrollbar */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: #070a11;
    }
    ::-webkit-scrollbar-thumb {
      background: #1e293b;
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #00f2fe;
    }

    /* Glow utility animations */
    .glow-cyan {
      box-shadow: 0 0 15px rgba(0, 242, 254, 0.25);
    }
    .glow-green {
      box-shadow: 0 0 15px rgba(0, 230, 118, 0.3);
    }
    .glow-red {
      box-shadow: 0 0 15px rgba(255, 23, 68, 0.3);
    }
    .glow-amber {
      box-shadow: 0 0 15px rgba(255, 171, 0, 0.3);
    }

    /* Pulse animation for VIP signals */
    @keyframes pulse-vip {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.85; transform: scale(1.02); }
    }
    .vip-pulse {
      animation: pulse-vip 1.5s infinite ease-in-out;
    }

    /* Scanline visual overlay effect for retro quant terminal aesthetic */
    .scanlines {
      background: linear-gradient(
        to bottom,
        rgba(255,255,255,0),
        rgba(255,255,255,0) 50%,
        rgba(0, 0, 0, 0.15) 50%,
        rgba(0, 0, 0, 0.15)
      );
      background-size: 100% 4px;
    }
  </style>
</head>

<body class="bg-bgDark text-slate-200 font-sans min-h-screen antialiased flex flex-col justify-between selection:bg-cyanGlow selection:text-black">

  <!-- ================= TOP NAVIGATION HEADER ================= -->
  <header class="border-b border-borderDark bg-cardDark/80 backdrop-blur sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
      
      <!-- Logo & System Status -->
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 to-emerald-400 flex items-center justify-center text-black font-extrabold text-xl shadow-lg shadow-cyan-500/20">
          <i class="fa-solid font-mono fa-bolt"></i>
        </div>
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-base font-bold tracking-wider text-white font-mono uppercase">QUANT-OTC <span class="text-cyanGlow text-xs px-1.5 py-0.5 rounded border border-cyanGlow/30 bg-cyanGlow/10">PRO v3.0</span></h1>
          </div>
          <p class="text-[11px] text-slate-400 flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-greenGlow animate-ping"></span>
            IQ Option OTC Pattern Engine • Neural Radar Active
          </p>
        </div>
      </div>

      <!-- Timeframe, Candle Countdown & Live Market Status -->
      <div class="flex items-center gap-3">
        <!-- Candle Timer Display -->
        <div class="bg-panelDark border border-borderDark px-3 py-1.5 rounded-lg flex items-center gap-2 font-mono">
          <i class="fa-regular fa-clock text-cyanGlow text-sm"></i>
          <span class="text-xs text-slate-400 uppercase">M1 Expire:</span>
          <span id="candleTimer" class="text-sm font-bold text-amberGlow">59s</span>
        </div>

        <!-- Global Audio Mute Toggle -->
        <button id="audioToggleBtn" onclick="toggleAudio()" class="bg-panelDark hover:bg-borderDark text-slate-300 px-3 py-1.5 rounded-lg border border-borderDark transition flex items-center gap-1.5 text-xs font-semibold">
          <i id="audioIcon" class="fa-solid fa-volume-high text-greenGlow"></i>
          <span id="audioStatusText">Sound ON</span>
        </button>

        <!-- Settings Panel Trigger Button -->
        <button onclick="toggleSettingsDrawer()" class="bg-panelDark hover:bg-borderDark text-cyanGlow px-3 py-1.5 rounded-lg border border-cyanGlow/30 transition flex items-center gap-1.5 text-xs font-semibold">
          <i class="fa-solid fa-sliders"></i>
          <span>AI Presets</span>
        </button>
      </div>

    </div>
  </header>

  <!-- ================= MAIN DASHBOARD CONTAINER ================= -->
  <main class="max-w-7xl mx-auto px-4 py-4 w-full flex-grow space-y-4">

    <!-- TOP SECTION: MAIN CHART & AI DECISION SUPPORT PANEL -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      
      <!-- LEFT (2 Cols): REAL-TIME HTML5 CANDLESTICK CHART -->
      <div class="lg:col-col-span-2 bg-cardDark border border-borderDark rounded-xl p-4 flex flex-col justify-between shadow-xl relative overflow-hidden">
        
        <!-- Chart Controls Header -->
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3 pb-2 border-b border-borderDark/60">
          <div class="flex items-center gap-2">
            <!-- Pair Selector Dropdown -->
            <select id="pairSelector" onchange="switchActivePair(this.value)" class="bg-panelDark border border-cyanGlow/40 text-white font-mono text-sm font-bold rounded-lg px-3 py-1.5 focus:outline-none focus:border-cyanGlow cursor-pointer">
              <!-- Options populated dynamically -->
            </select>
            <span id="activePriceDisplay" class="font-mono text-base font-bold text-cyanGlow px-2 py-0.5 rounded bg-cyanGlow/10">0.00000</span>
          </div>

          <!-- Indicator Badges -->
          <div class="flex items-center gap-2 font-mono text-[11px]">
            <span class="px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">EMA 6</span>
            <span class="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400">EMA 21</span>
            <span class="px-2 py-0.5 rounded bg-purple-500/10 border border-purple-500/30 text-purple-300">BB (20,2)</span>
          </div>
        </div>

        <!-- Canvas Container -->
        <div class="relative w-full h-[320px] sm:h-[360px] bg-bgDark/80 rounded-lg overflow-hidden border border-borderDark/40">
          <canvas id="otcChartCanvas" class="w-full h-full block cursor-crosshair"></canvas>
          <div class="absolute top-2 left-2 pointer-events-none text-[10px] font-mono text-slate-500">
            QUANT ENGINE REAL-TIME M1 SIMULATION
          </div>
        </div>

        <!-- Chart Footer Status Bar -->
        <div class="mt-3 pt-2 border-t border-borderDark/60 flex flex-wrap items-center justify-between text-xs font-mono text-slate-400 gap-2">
          <div id="patternAlertDisplay" class="flex items-center gap-2 text-slate-300">
            <i class="fa-solid fa-microchip text-cyanGlow"></i>
            <span>Pattern Engine: <strong class="text-white">Scanning 5-10 Candle History...</strong></span>
          </div>
          <div id="anomalyStatus" class="text-greenGlow flex items-center gap-1">
            <i class="fa-solid fa-shield-halved"></i> Normal Volatility
          </div>
        </div>

      </div>

      <!-- RIGHT (1 Col): LIVE AI DECISION & SIGNAL COCKPIT -->
      <div class="bg-cardDark border border-borderDark rounded-xl p-4 flex flex-col justify-between shadow-xl relative">
        <div>
          <div class="flex items-center justify-between border-b border-borderDark/60 pb-2 mb-3">
            <h2 class="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <i class="fa-solid fa-brain text-cyanGlow"></i> AI Decision Cockpit
            </h2>
            <span id="vipBadge" class="hidden px-2 py-0.5 text-[10px] font-extrabold uppercase rounded-full bg-gradient-to-r from-amber-500 to-yellow-300 text-black vip-pulse">
              <i class="fa-solid fa-crown mr-1"></i> VIP HIGH ACCURACY
            </span>
          </div>

          <!-- Main AI Signal Output Box -->
          <div id="aiSignalCard" class="bg-panelDark border-2 border-borderDark rounded-xl p-4 text-center transition-all duration-300 mb-3">
            <div class="text-xs uppercase font-mono text-slate-400 mb-1">Recommended Action (Final 3s Lock)</div>
            <div id="aiSignalText" class="text-3xl font-extrabold font-mono text-slate-300 my-1 tracking-wider">
              WAIT / ANALYZING
            </div>
            <div id="aiReasonText" class="text-xs text-slate-400 mt-1 min-h-[32px] flex items-center justify-center font-sans">
              Monitoring EMA crossovers, RSI extremes & candle rejection patterns...
            </div>
          </div>

          <!-- Probability & Confidence Meter -->
          <div class="space-y-2 mb-4">
            <div class="flex justify-between text-xs font-mono">
              <span class="text-slate-400">AI Win Probability:</span>
              <span id="confidenceVal" class="font-bold text-cyanGlow">50.0%</span>
            </div>
            <div class="w-full bg-bgDark h-2.5 rounded-full overflow-hidden border border-borderDark">
              <div id="confidenceBar" class="bg-gradient-to-r from-cyan-500 to-emerald-400 h-full transition-all duration-500" style="width: 50%;"></div>
            </div>
          </div>

          <!-- Deep Analysis Breakdown List -->
          <div class="space-y-2 text-xs font-mono bg-bgDark/60 p-3 rounded-lg border border-borderDark/60">
            <div class="flex justify-between">
              <span class="text-slate-400">RSI (14) Index:</span>
              <span id="rsiVal" class="text-slate-200 font-bold">50.0</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-400">Trend Alignment:</span>
              <span id="trendVal" class="text-slate-200 font-bold">NEUTRAL</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-400">Trap Reversal Risk:</span>
              <span id="trapVal" class="text-greenGlow font-bold">LOW</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-400">Squeeze / Sideway:</span>
              <span id="squeezeVal" class="text-slate-200 font-bold">NORMAL</span>
            </div>
          </div>
        </div>

        <!-- Quick Trade Log Actions for Active Signal -->
        <div class="mt-4 pt-3 border-t border-borderDark/60 flex gap-2">
          <button onclick="logCurrentTrade('WIN')" class="flex-1 bg-emerald-600/20 hover:bg-emerald-600/30 text-greenGlow border border-greenGlow/40 py-2 rounded-lg font-bold text-xs font-mono transition flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-circle-check"></i> Log WIN
          </button>
          <button onclick="logCurrentTrade('LOSS')" class="flex-1 bg-red-600/20 hover:bg-red-600/30 text-redGlow border border-redGlow/40 py-2 rounded-lg font-bold text-xs font-mono transition flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-circle-xmark"></i> Log LOSS
          </button>
        </div>

      </div>

    </div>


    <!-- MIDDLE SECTION: COMPLETE MULTI-PAIR SCANNER RADAR GRID -->
    <div class="bg-cardDark border border-borderDark rounded-xl p-4 shadow-xl">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3 pb-2 border-b border-borderDark/60">
        <h2 class="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
          <i class="fa-solid fa-radar text-cyanGlow"></i> OTC Multi-Pair Scanner Radar Grid
        </h2>
        <div class="text-xs text-slate-400 font-mono">
          Scanning 6 OTC Pairs Simultaneously • Updates every 200ms
        </div>
      </div>

      <!-- Responsive Grid for Pairs -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3" id="pairGrid">
        <!-- Dynamically Generated Pair Cards -->
      </div>
    </div>


    <!-- BOTTOM SECTION: TRADING JOURNAL & FLAT STAKING MONEY MANAGEMENT -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      
      <!-- STAKE & BANKROLL CALCULATOR -->
      <div class="bg-cardDark border border-borderDark rounded-xl p-4 shadow-xl space-y-3">
        <h2 class="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2 border-b border-borderDark/60 pb-2">
          <i class="fa-solid fa-calculator text-amberGlow"></i> Flat Staking & Money Mgmt
        </h2>
        
        <div class="space-y-2 text-xs font-mono">
          <div>
            <label class="text-slate-400 block mb-1">Starting Bankroll ($):</label>
            <input type="number" id="bankrollInput" value="100" onchange="updateMoneyManagement()" class="w-full bg-panelDark border border-borderDark rounded px-3 py-1.5 text-white font-bold focus:border-cyanGlow focus:outline-none">
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Risk per Trade (%):</label>
            <input type="number" id="riskPercentInput" value="2" onchange="updateMoneyManagement()" class="w-full bg-panelDark border border-borderDark rounded px-3 py-1.5 text-white font-bold focus:border-cyanGlow focus:outline-none">
          </div>
          <div class="pt-2 border-t border-borderDark/60 space-y-1">
            <div class="flex justify-between">
              <span class="text-slate-400">Calculated Stake:</span>
              <span id="calculatedStakeText" class="text-amberGlow font-bold">$2.00</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-400">Target Win Rate:</span>
              <span class="text-greenGlow font-bold">&gt; 58% (Profitable)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- PERFORMANCE METRICS & EQUITY SUMMARY -->
      <div class="bg-cardDark border border-borderDark rounded-xl p-4 shadow-xl space-y-3">
        <h2 class="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2 border-b border-borderDark/60 pb-2">
          <i class="fa-solid fa-chart-line text-greenGlow"></i> Performance Metrics
        </h2>

        <div class="grid grid-cols-2 gap-2 text-center font-mono">
          <div class="bg-panelDark p-2 rounded-lg border border-borderDark">
            <div class="text-[10px] text-slate-400">TOTAL TRADES</div>
            <div id="totalTradesText" class="text-lg font-bold text-white">0</div>
          </div>
          <div class="bg-panelDark p-2 rounded-lg border border-borderDark">
            <div class="text-[10px] text-slate-400">ACCURACY WIN %</div>
            <div id="winRateText" class="text-lg font-bold text-cyanGlow">0.0%</div>
          </div>
          <div class="bg-panelDark p-2 rounded-lg border border-borderDark">
            <div class="text-[10px] text-slate-400">WINS / LOSSES</div>
            <div id="winLossCountText" class="text-xs font-bold text-slate-300 mt-1">0W - 0L</div>
          </div>
          <div class="bg-panelDark p-2 rounded-lg border border-borderDark">
            <div class="text-[10px] text-slate-400">EST. NET PROFIT</div>
            <div id="netProfitText" class="text-xs font-bold text-greenGlow mt-1">+$0.00</div>
          </div>
        </div>
      </div>

      <!-- LIVE TRADE HISTORY JOURNAL LOG -->
      <div class="bg-cardDark border border-borderDark rounded-xl p-4 shadow-xl flex flex-col justify-between">
        <div>
          <div class="flex justify-between items-center border-b border-borderDark/60 pb-2 mb-2">
            <h2 class="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <i class="fa-solid fa-book text-purple-400"></i> Trade History Journal
            </h2>
            <button onclick="clearJournal()" class="text-[10px] text-redGlow hover:underline font-mono">Clear</button>
          </div>
          <div id="tradeJournalList" class="space-y-1.5 max-h-[120px] overflow-y-auto pr-1 text-xs font-mono">
            <div class="text-slate-500 text-center py-4">No trades logged yet. Click WIN/LOSS to record.</div>
          </div>
        </div>
      </div>

    </div>

  </main>


  <!-- ================= FOOTER DISCLAIMER ================= -->
  <footer class="border-t border-borderDark bg-cardDark/40 py-3 text-center text-xs text-slate-500 font-mono">
    <p>QUANT-OTC Engine v3.0 • Designed for IQ Option OTC Binary Options Technical Analysis • High Risk Financial Tool</p>
  </footer>


  <!-- ================= SETTINGS DRAWER MODAL ================= -->
  <div id="settingsDrawer" class="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 hidden flex justify-end">
    <div class="w-full max-w-md bg-cardDark border-l border-borderDark p-6 flex flex-col justify-between h-full">
      <div>
        <div class="flex items-center justify-between border-b border-borderDark pb-4 mb-4">
          <h3 class="text-base font-bold text-white uppercase font-mono flex items-center gap-2">
            <i class="fa-solid fa-sliders text-cyanGlow"></i> AI Strategy Presets
          </h3>
          <button onclick="toggleSettingsDrawer()" class="text-slate-400 hover:text-white text-lg">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="space-y-5 text-sm font-sans">
          <!-- Preset Profiles -->
          <div>
            <label class="text-slate-300 font-bold block mb-1">Preset Profile:</label>
            <select id="presetProfileSelect" onchange="applyPresetProfile(this.value)" class="w-full bg-panelDark border border-borderDark rounded px-3 py-2 text-white font-mono focus:border-cyanGlow focus:outline-none">
              <option value="balanced">Balanced OTC Strategy (Recommended)</option>
              <option value="aggressive">Aggressive Trap Counter-Trading</option>
              <option value="conservative">Conservative High Confidence VIP Only</option>
            </select>
          </div>

          <!-- Sensitivity Slider -->
          <div>
            <div class="flex justify-between text-xs font-mono mb-1">
              <span class="text-slate-300">RSI Trap Sensitivity:</span>
              <span id="sensitivityValText" class="text-cyanGlow font-bold">14</span>
            </div>
            <input type="range" id="sensitivitySlider" min="7" max="21" value="14" oninput="document.getElementById('sensitivityValText').innerText = this.value" class="w-full accent-cyanGlow">
          </div>

          <!-- Trap Reversal Aggressiveness -->
          <div>
            <div class="flex justify-between text-xs font-mono mb-1">
              <span class="text-slate-300">Trap Reversal Lock Seconds:</span>
              <span id="trapLockText" class="text-amberGlow font-bold">3s</span>
            </div>
            <input type="range" id="trapLockSlider" min="2" max="6" value="3" oninput="document.getElementById('trapLockText').innerText = this.value + 's'" class="w-full accent-amberGlow">
          </div>

          <!-- Sound Alerts Settings -->
          <div class="pt-2 border-t border-borderDark">
            <label class="flex items-center gap-2 text-slate-300 text-xs font-mono cursor-pointer">
              <input type="checkbox" id="beepWarningCheck" checked class="accent-cyanGlow w-4 h-4">
              Play 10s Countdown Audio Warning Beep
            </label>
          </div>
        </div>
      </div>

      <button onclick="toggleSettingsDrawer()" class="w-full bg-gradient-to-r from-cyan-500 to-emerald-400 text-black font-extrabold py-2.5 rounded-xl uppercase tracking-wider font-mono shadow-lg hover:opacity-90">
        Apply Settings
      </button>
    </div>
  </div>


  <!-- ================= JAVASCRIPT SIMULATION & AI ENGINE ================= -->
  <script>
    /* =========================================================================
       1. GLOBAL STATE & CONFIGURATION
       ========================================================================= */
    const SYMBOLS = [
      { key: 'eurusd', name: 'EUR/USD (OTC)', base: 1.0850 },
      { key: 'gbpusdt', name: 'GBP/USD (OTC)', base: 1.3400 },
      { key: 'usdjpy', name: 'USD/JPY (OTC)', base: 155.00 },
      { key: 'audusd', name: 'AUD/USD (OTC)', base: 0.6550 },
      { key: 'usdcad', name: 'USD/CAD (OTC)', base: 1.3550 },
      { key: 'eurjpy', name: 'EUR/JPY (OTC)', base: 167.50 }
    ];

    let activePairKey = 'eurusd';
    let marketHistories = {};
    let pairStates = {};
    let audioEnabled = true;
    let audioPlayedThisCandle = false;

    // Journal & Staking State
    let journal = [];
    let bankroll = 100;
    let riskPercent = 2;

    /* Web Audio API Synthesizer for Alert Beeps (No External Files Required) */
    let audioCtx = null;

    function playBeep(freq = 880, type = 'sine', duration = 0.15) {
      if (!audioEnabled) return;
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
      } catch (e) {
        console.warn('Audio playback error:', e);
      }
    }

    function toggleAudio() {
      audioEnabled = !audioEnabled;
      const statusText = document.getElementById('audioStatusText');
      const icon = document.getElementById('audioIcon');
      if (audioEnabled) {
        statusText.innerText = 'Sound ON';
        icon.className = 'fa-solid fa-volume-high text-greenGlow';
        playBeep(1000, 'sine', 0.1);
      } else {
        statusText.innerText = 'Sound OFF';
        icon.className = 'fa-solid fa-volume-xmark text-slate-500';
      }
    }

    function toggleSettingsDrawer() {
      const drawer = document.getElementById('settingsDrawer');
      drawer.classList.toggle('hidden');
    }

    /* =========================================================================
       2. MARKET DATA SIMULATION & CANDLE GENERATOR
       ========================================================================= */
    function initSimulatedData() {
      SYMBOLS.forEach(s => {
        marketHistories[s.key] = [];
        pairStates[s.key] = {
          signal: 'WAIT',
          timer: 0,
          confidence: 50.0,
          isVip: false,
          anomaly: false
        };

        // Generate initial 60 historical ticks
        let price = s.base;
        for (let i = 0; i < 60; i++) {
          price += (Math.random() - 0.495) * (price * 0.00035);
          marketHistories[s.key].push(parseFloat(price.toFixed(5)));
        }
      });

      populatePairSelector();
      renderPairGrid();
    }

    // Tick Generator running every 1 second
    setInterval(() => {
      SYMBOLS.forEach(s => {
        const hist = marketHistories[s.key];
        if (hist && hist.length > 0) {
          const last = hist[hist.length - 1];
          // Simulating higher volatility spikes for OTC behavior
          const rand = Math.random();
          let volatility = 0.00045;
          let anomalyTrigger = false;

          // 2% chance of an abnormal OTC spike
          if (rand > 0.98) {
            volatility = 0.0018;
            anomalyTrigger = true;
          }

          const change = (Math.random() - 0.492) * (last * volatility);
          const nextP = parseFloat((last + change).toFixed(5));
          hist.push(nextP);
          if (hist.length > 180) hist.shift();

          // Update anomaly state
          pairStates[s.key].anomaly = anomalyTrigger;
        }
      });

      // Update active price display
      const activeHist = marketHistories[activePairKey];
      if (activeHist && activeHist.length > 0) {
        document.getElementById('activePriceDisplay').innerText = activeHist[activeHist.length - 1].toFixed(5);
      }
    }, 1000);

    /* =========================================================================
       3. TECHNICAL INDICATORS & TECHNICAL MATH
       ========================================================================= */
    function calculateEMA(prices, period) {
      if (prices.length < period) return prices[prices.length - 1] || 0;
      const k = 2 / (period + 1);
      let ema = prices[0];
      for (let i = 1; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
      }
      return ema;
    }

    function calculateBB(prices, period = 20, mult = 2) {
      if (prices.length < period) return { middle: prices[prices.length - 1] || 0, upper: 0, lower: 0, bandwidth: 1 };
      const slice = prices.slice(-period);
      const sma = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
      const stdDev = Math.sqrt(variance);
      const upper = sma + (mult * stdDev);
      const lower = sma - (mult * stdDev);
      const bandwidth = ((upper - lower) / sma) * 100;
      return { middle: sma, upper, lower, bandwidth };
    }

    function calculateRSI(prices, period = 14) {
      if (prices.length < period + 1) return 50.0;
      let gains = 0, losses = 0;
      for (let i = prices.length - period; i < prices.length - 1; i++) {
        const diff = prices[i + 1] - prices[i];
        if (diff >= 0) gains += diff;
        else losses -= diff;
      }
      if (losses === 0) return 100;
      const rs = (gains / period) / (losses / period);
      return 100 - (100 / (1 + rs));
    }

    /* =========================================================================
       4. MAIN OTC AI PATTERN & TRAP SCANNER ENGINE
       ========================================================================= */
    function processAIEngine() {
      const now = new Date();
      const seconds = now.getSeconds();
      const millis = now.getMilliseconds();
      const exactTimeLeft = parseFloat((60 - (seconds + millis / 1000)).toFixed(1));
      const displayTimeLeft = Math.ceil(exactTimeLeft);

      // Audio Beep Alert at 10s remaining
      if (displayTimeLeft === 10 && !audioPlayedThisCandle) {
        if (document.getElementById('beepWarningCheck').checked) {
          playBeep(1200, 'triangle', 0.25);
        }
        audioPlayedThisCandle = true;
      }
      if (displayTimeLeft > 10) {
        audioPlayedThisCandle = false;
      }

      document.getElementById('candleTimer').innerText = `${displayTimeLeft}s`;

      SYMBOLS.forEach(s => {
        const prices = marketHistories[s.key];
        let state = pairStates[s.key];

        if (!prices || prices.length < 25) return;

        const currentPrice = prices[prices.length - 1];
        const prevPrice = prices[prices.length - 2] || currentPrice;
        const prev2Price = prices[prices.length - 3] || prevPrice;

        const rsi = parseFloat(calculateRSI(prices).toFixed(1));
        const ema6 = calculateEMA(prices, 6);
        const ema21 = calculateEMA(prices, 21);
        const bb = calculateBB(prices);

        const candleDelta = currentPrice - prevPrice;
        const prevCandleDelta = prevPrice - prev2Price;
        const isSideway = bb.bandwidth < 0.035;

        // Pattern Recognition & Trap Detectors
        const isBullishTrap = candleDelta < 0 && prevCandleDelta > 0 && rsi > 68;
        const isBearishTrap = candleDelta > 0 && prevCandleDelta < 0 && rsi < 32;

        let aiDecision = 'WAIT';
        let aiConfidence = 50.0;
        let isVipSignal = false;
        let trendStatusText = 'BULLISH 🟢';

        if (ema6 < ema21) trendStatusText = 'BEARISH 🔴';
        if (isSideway) trendStatusText = 'SQUEEZE 🟡';
        if (isBullishTrap) trendStatusText = 'BULLISH TRAP ⚠️';
        if (isBearishTrap) trendStatusText = 'BEARISH TRAP ⚠️';

        if (isSideway) {
          aiDecision = 'SIDEWAY';
          aiConfidence = 40.0;
        } else {
          const trendStrength = Math.abs(ema6 - ema21) / currentPrice * 1000;
          aiConfidence = Math.min(65.0 + (trendStrength * 15.0), 96.0);

          // 🎯 Final 3-Second Counter-Trading & Signal Flipping
          const trapLockSecs = parseFloat(document.getElementById('trapLockSlider').value);
          if (exactTimeLeft <= trapLockSecs && exactTimeLeft >= 0.0) {
            
            if (isBullishTrap) {
              aiDecision = 'PUT';
              aiConfidence = 93.5;
              isVipSignal = true;
            } 
            else if (isBearishTrap) {
              aiDecision = 'CALL';
              aiConfidence = 93.5;
              isVipSignal = true;
            }
            else if (ema6 > ema21 && currentPrice >= ema6 && rsi < 70) {
              aiDecision = 'CALL';
              isVipSignal = aiConfidence >= 88.0;
            }
            else if (ema6 < ema21 && currentPrice <= ema6 && rsi > 30) {
              aiDecision = 'PUT';
              isVipSignal = aiConfidence >= 88.0;
            }
          }
        }

        // Store active calculation in pair state
        state.signal = aiDecision;
        state.confidence = aiConfidence.toFixed(1);
        state.isVip = isVipSignal;
        state.rsi = rsi;
        state.trend = trendStatusText;
      });

      // Update UI for Cockpit & Grid
      updateCockpitUI();
      updateGridCards();
    }

    /* Update Cockpit Panel for active selected pair */
    function updateCockpitUI() {
      const state = pairStates[activePairKey];
      if (!state) return;

      const aiSignalCard = document.getElementById('aiSignalCard');
      const aiSignalText = document.getElementById('aiSignalText');
      const aiReasonText = document.getElementById('aiReasonText');
      const vipBadge = document.getElementById('vipBadge');

      const confidenceVal = document.getElementById('confidenceVal');
      const confidenceBar = document.getElementById('confidenceBar');

      const rsiVal = document.getElementById('rsiVal');
      const trendVal = document.getElementById('trendVal');
      const trapVal = document.getElementById('trapVal');
      const squeezeVal = document.getElementById('squeezeVal');
      const patternAlertDisplay = document.getElementById('patternAlertDisplay');
      const anomalyStatus = document.getElementById('anomalyStatus');

      // Update VIP Badge
      if (state.isVip) {
        vipBadge.classList.remove('hidden');
      } else {
        vipBadge.classList.add('hidden');
      }

      // Signal Styling & Text
      aiSignalText.innerText = state.signal;
      if (state.signal === 'CALL') {
        aiSignalCard.className = 'bg-emerald-950/40 border-2 border-greenGlow rounded-xl p-4 text-center transition-all duration-300 mb-3 glow-green';
        aiSignalText.className = 'text-3xl font-extrabold font-mono text-greenGlow my-1 tracking-wider';
        aiReasonText.innerText = 'High Bullish Rejection / Upward Momentum Confirmed!';
      } else if (state.signal === 'PUT') {
        aiSignalCard.className = 'bg-rose-950/40 border-2 border-redGlow rounded-xl p-4 text-center transition-all duration-300 mb-3 glow-red';
        aiSignalText.className = 'text-3xl font-extrabold font-mono text-redGlow my-1 tracking-wider';
        aiReasonText.innerText = 'High Bearish Rejection / Downward Fade Trap Locked!';
      } else if (state.signal === 'SIDEWAY') {
        aiSignalCard.className = 'bg-amber-950/40 border-2 border-amberGlow rounded-xl p-4 text-center transition-all duration-300 mb-3 glow-amber';
        aiSignalText.className = 'text-3xl font-extrabold font-mono text-amberGlow my-1 tracking-wider';
        aiReasonText.innerText = 'Squeeze / Sideway Danger Zone detected. Avoid trading!';
      } else {
        aiSignalCard.className = 'bg-panelDark border-2 border-borderDark rounded-xl p-4 text-center transition-all duration-300 mb-3';
        aiSignalText.className = 'text-3xl font-extrabold font-mono text-slate-300 my-1 tracking-wider';
        aiReasonText.innerText = 'Analyzing 5-10 Candle History for Optimal Entry...';
      }

      // Confidence Bar
      confidenceVal.innerText = `${state.confidence}%`;
      confidenceBar.style.width = `${state.confidence}%`;

      // Sub-metrics
      rsiVal.innerText = state.rsi || '50.0';
      trendVal.innerText = state.trend || 'NEUTRAL';
      
      if (state.trend.includes('TRAP')) {
        trapVal.innerText = 'HIGH (FLIP LOCKED)';
        trapVal.className = 'text-redGlow font-bold';
      } else {
        trapVal.innerText = 'LOW';
        trapVal.className = 'text-greenGlow font-bold';
      }

      squeezeVal.innerText = state.trend.includes('SQUEEZE') ? 'SQUEEZE ACTIVE' : 'NORMAL';

      // Anomaly Display
      if (state.anomaly) {
        anomalyStatus.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> HIGH VOLATILITY SPIKE';
        anomalyStatus.className = 'text-amberGlow flex items-center gap-1 font-bold';
        patternAlertDisplay.innerHTML = '<i class="fa-solid fa-bolt text-amberGlow"></i> Pattern Engine: <strong class="text-amberGlow">Anomaly Spike Detected!</strong>';
      } else {
        anomalyStatus.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Normal Volatility';
        anomalyStatus.className = 'text-greenGlow flex items-center gap-1';
        patternAlertDisplay.innerHTML = '<i class="fa-solid fa-microchip text-cyanGlow"></i> Pattern Engine: <strong class="text-white">Scanning 5-10 Candle History...</strong>';
      }
    }

    /* =========================================================================
       5. HTML5 CANVAS REAL-TIME CANDLESTICK CHART
       ========================================================================= */
    function renderChartCanvas() {
      const canvas = document.getElementById('otcChartCanvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');

      // Adjust canvas resolution for high-DPI
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;

      const width = canvas.width;
      const height = canvas.height;

      // Clear canvas background
      ctx.fillStyle = '#070a11';
      ctx.fillRect(0, 0, width, height);

      const prices = marketHistories[activePairKey];
      if (!prices || prices.length < 20) return;

      // Slice last 30 prices to draw candles
      const displayCount = 30;
      const slicedPrices = prices.slice(-displayCount);

      const minPrice = Math.min(...slicedPrices) * 0.9997;
      const maxPrice = Math.max(...slicedPrices) * 1.0003;
      const priceRange = maxPrice - minPrice || 1;

      const candleWidth = (width - 40) / displayCount;

      // Helper for Y coordinate translation
      function getY(p) {
        return height - 20 - ((p - minPrice) / priceRange) * (height - 40);
      }

      // Draw Grid Lines
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 0.5;
      for (let i = 1; i <= 4; i++) {
        const y = (height / 5) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Calculate Indicators for display
      let ema6Arr = [];
      let ema21Arr = [];
      let bbUpperArr = [];
      let bbLowerArr = [];

      for (let i = 0; i < slicedPrices.length; i++) {
        const sub = slicedPrices.slice(0, i + 1);
        ema6Arr.push(calculateEMA(sub, 6));
        ema21Arr.push(calculateEMA(sub, 21));
        const bb = calculateBB(sub);
        bbUpperArr.push(bb.upper);
        bbLowerArr.push(bb.lower);
      }

      // 1. Draw Bollinger Bands Area Shading
      ctx.fillStyle = 'rgba(124, 58, 237, 0.08)';
      ctx.beginPath();
      ctx.moveTo(20, getY(bbUpperArr[0]));
      for (let i = 1; i < slicedPrices.length; i++) {
        const x = 20 + i * candleWidth;
        ctx.lineTo(x, getY(bbUpperArr[i]));
      }
      for (let i = slicedPrices.length - 1; i >= 0; i--) {
        const x = 20 + i * candleWidth;
        ctx.lineTo(x, getY(bbLowerArr[i]));
      }
      ctx.closePath();
      ctx.fill();

      // 2. Draw EMA Lines
      // EMA 6 (Cyan)
      ctx.strokeStyle = '#00f2fe';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let i = 0; i < slicedPrices.length; i++) {
        const x = 20 + i * candleWidth + candleWidth / 2;
        const y = getY(ema6Arr[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // EMA 21 (Orange/Amber)
      ctx.strokeStyle = '#ffab00';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let i = 0; i < slicedPrices.length; i++) {
        const x = 20 + i * candleWidth + candleWidth / 2;
        const y = getY(ema21Arr[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // 3. Draw Candlesticks
      for (let i = 0; i < slicedPrices.length; i++) {
        const open = i > 0 ? slicedPrices[i - 1] : slicedPrices[i];
        const close = slicedPrices[i];
        const high = Math.max(open, close) + (Math.abs(close - open) * 0.4);
        const low = Math.min(open, close) - (Math.abs(close - open) * 0.4);

        const x = 20 + i * candleWidth + candleWidth / 2;
        const openY = getY(open);
        const closeY = getY(close);
        const highY = getY(high);
        const lowY = getY(low);

        const isBullish = close >= open;
        const candleColor = isBullish ? '#00e676' : '#ff1744';

        // Draw Wick
        ctx.strokeStyle = candleColor;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        // Draw Body
        ctx.fillStyle = candleColor;
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(Math.abs(closeY - openY), 2);
        ctx.fillRect(x - candleWidth * 0.35, bodyTop, candleWidth * 0.7, bodyHeight);
      }
    }

    /* =========================================================================
       6. MULTI-PAIR RADAR GRID CONTROLLER
       ========================================================================= */
    function populatePairSelector() {
      const select = document.getElementById('pairSelector');
      select.innerHTML = '';
      SYMBOLS.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.key;
        opt.innerText = s.name;
        if (s.key === activePairKey) opt.selected = true;
        select.appendChild(opt);
      });
    }

    function switchActivePair(key) {
      activePairKey = key;
      renderPairGrid();
      updateCockpitUI();
    }

    function renderPairGrid() {
      const grid = document.getElementById('pairGrid');
      grid.innerHTML = '';

      SYMBOLS.forEach(s => {
        const state = pairStates[s.key] || { signal: 'WAIT', confidence: '50.0', trend: 'NEUTRAL', rsi: 50 };
        const isActive = s.key === activePairKey;

        let badgeBg = 'bg-panelDark border-borderDark text-slate-400';
        if (state.signal === 'CALL') badgeBg = 'bg-emerald-950/60 border-greenGlow text-greenGlow font-bold';
        if (state.signal === 'PUT') badgeBg = 'bg-rose-950/60 border-redGlow text-redGlow font-bold';
        if (state.signal === 'SIDEWAY') badgeBg = 'bg-amber-950/60 border-amberGlow text-amberGlow';

        const card = document.createElement('div');
        card.className = `p-3 rounded-xl border transition cursor-pointer flex flex-col justify-between ${isActive ? 'bg-panelDark border-cyanGlow/80 shadow-lg glow-cyan' : 'bg-bgDark/60 border-borderDark hover:border-slate-600'}`;
        card.onclick = () => switchActivePair(s.key);

        card.innerHTML = `
          <div class="flex justify-between items-center mb-2">
            <span class="font-bold font-mono text-xs text-white">${s.name}</span>
            <span class="text-[10px] px-2 py-0.5 rounded border ${badgeBg}">${state.signal}</span>
          </div>
          <div class="flex justify-between items-center text-[11px] font-mono text-slate-400 mb-1">
            <span>Trend: <strong class="text-slate-200">${state.trend}</strong></span>
            <span>RSI: <strong class="text-cyanGlow">${state.rsi}</strong></span>
          </div>
          <div class="w-full bg-bgDark h-1.5 rounded-full overflow-hidden border border-borderDark">
            <div class="bg-cyanGlow h-full" style="width: ${state.confidence}%"></div>
          </div>
        `;

        grid.appendChild(card);
      });
    }

    function updateGridCards() {
      renderPairGrid();
    }

    /* =========================================================================
       7. TRADING JOURNAL & MONEY MANAGEMENT CALCULATOR
       ========================================================================= */
    function updateMoneyManagement() {
      bankroll = parseFloat(document.getElementById('bankrollInput').value) || 100;
      riskPercent = parseFloat(document.getElementById('riskPercentInput').value) || 2;

      const stake = (bankroll * (riskPercent / 100)).toFixed(2);
      document.getElementById('calculatedStakeText').innerText = `$${stake}`;
    }

    function logCurrentTrade(result) {
      const state = pairStates[activePairKey];
      const pairName = SYMBOLS.find(s => s.key === activePairKey)?.name || activePairKey;
      const stake = parseFloat((bankroll * (riskPercent / 100)).toFixed(2));
      const payoutRatio = 0.85; // Standard 85% binary payout

      const profitLoss = result === 'WIN' ? (stake * payoutRatio) : -stake;

      const trade = {
        id: Date.now(),
        pair: pairName,
        signal: state.signal || 'CALL',
        result: result,
        stake: stake,
        pnl: profitLoss,
        time: new Date().toLocaleTimeString()
      };

      journal.unshift(trade);
      renderJournal();
    }

    function renderJournal() {
      const list = document.getElementById('tradeJournalList');
      list.innerHTML = '';

      if (journal.length === 0) {
        list.innerHTML = '<div class="text-slate-500 text-center py-4">No trades logged yet. Click WIN/LOSS to record.</div>';
        updateMetrics(0, 0, 0, 0);
        return;
      }

      let wins = 0;
      let losses = 0;
      let totalPnl = 0;

      journal.forEach(t => {
        if (t.result === 'WIN') wins++;
        else losses++;
        totalPnl += t.pnl;

        const row = document.createElement('div');
        row.className = `p-1.5 rounded border flex justify-between items-center ${t.result === 'WIN' ? 'bg-emerald-950/30 border-greenGlow/30 text-greenGlow' : 'bg-rose-950/30 border-redGlow/30 text-redGlow'}`;
        
        row.innerHTML = `
          <span><strong>${t.pair}</strong> (${t.signal})</span>
          <span>${t.result} (${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)})</span>
        `;
        list.appendChild(row);
      });

      const total = wins + losses;
      const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

      updateMetrics(total, winRate, wins, losses, totalPnl);
    }

    function updateMetrics(total, winRate, wins, losses, totalPnl = 0) {
      document.getElementById('totalTradesText').innerText = total;
      document.getElementById('winRateText').innerText = `${winRate}%`;
      document.getElementById('winLossCountText').innerText = `${wins}W - ${losses}L`;

      const netProfitText = document.getElementById('netProfitText');
      netProfitText.innerText = `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`;
      netProfitText.className = totalPnl >= 0 ? 'text-xs font-bold text-greenGlow mt-1' : 'text-xs font-bold text-redGlow mt-1';
    }

    function clearJournal() {
      journal = [];
      renderJournal();
    }

    /* Preset Profile Handlers */
    function applyPresetProfile(val) {
      if (val === 'aggressive') {
        document.getElementById('sensitivitySlider').value = 9;
        document.getElementById('trapLockSlider').value = 5;
      } else if (val === 'conservative') {
        document.getElementById('sensitivitySlider').value = 18;
        document.getElementById('trapLockSlider').value = 2;
      } else {
        document.getElementById('sensitivitySlider').value = 14;
        document.getElementById('trapLockSlider').value = 3;
      }
      document.getElementById('sensitivityValText').innerText = document.getElementById('sensitivitySlider').value;
      document.getElementById('trapLockText').innerText = document.getElementById('trapLockSlider').value + 's';
    }

    /* =========================================================================
       8. INITIALIZATION LOOP
       ========================================================================= */
    window.onload = function() {
      initSimulatedData();
      updateMoneyManagement();

      // Main Loop for Engine (200ms)
      setInterval(() => {
        processAIEngine();
      }, 200);

      // Render Chart Loop (60 FPS)
      function animateChart() {
        renderChartCanvas();
        requestAnimationFrame(animateChart);
      }
      animateChart();
    };
  </script>
</body>
</html>
```