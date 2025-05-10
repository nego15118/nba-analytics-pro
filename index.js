// Configuración global
const API_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";
const TEAMS_API = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams";
const HISTORICAL_DAYS_LIMIT = 360; // Límite de días para análisis histórico
const CACHE_DURATION = 10 * 60 * 60 * 1000; // 10 horas en milisegundos
const ODDS_API = "https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=YOUR_API_KEY&regions=eu&markets=totals,h2h"; // API de cuotas (necesitarás una clave)

// Variables globales
let allTeams = [];
let teamLogos = {};
let currentPage = 'today';
let liveGamesInterval = null;
let historicalData = {};
let regressionModels = {};
let gamesCache = {};
let currentRegressionData = {};
let regressionCache = {
  lastUpdated: null,
  data: null
};
let pageState = {
  historical: {},
  probabilities: {},
  backtesting: {},
  projection: {}
};
// Agrega esto con las otras variables globales
let notificationPermission = false;
let liveGamesCheckInterval = null;
const notificationTimers = {};


async function fetchGamesForDate(dateStr) {
  // Verificar primero si tenemos datos en caché
  if (gamesCache[dateStr] && (Date.now() - gamesCache[dateStr].timestamp < CACHE_DURATION)) {
    return gamesCache[dateStr].data;
  }
  
  try {
    const response = await fetch(`${API_URL}?dates=${dateStr}`);
    const data = await response.json();
    
    let games = [];
    
    if (data.events && data.events.length > 0) {
      games = data.events.map(event => {
        const competition = event.competitions[0];
        const homeTeam = competition.competitors.find(c => c.homeAway === 'home').team;
        const awayTeam = competition.competitors.find(c => c.homeAway === 'away').team;
        
        const homeScores = getQuarterScores(competition.competitors.find(c => c.homeAway === 'home'));
        const awayScores = getQuarterScores(competition.competitors.find(c => c.homeAway === 'away'));
        
        const status = competition.status.type;
        const completed = status.completed;
        const inProgress = !completed && status.state === 'in';
        
        // Asegurarnos de incluir un identificador único para cada juego
        const gameId = event.id || `${dateStr}-${homeTeam.abbreviation}-vs-${awayTeam.abbreviation}`;
        
        return {
          id: gameId,                        // Identificador único añadido
          name: event.shortName || gameId,   // Nombre legible o fallback al ID
          shortName: event.shortName,
          date: dateStr,
          homeTeam,
          awayTeam,
          homeScores,
          awayScores,
          homeScore: parseInt(competition.competitors.find(c => c.homeAway === 'home').score) || 0,
          awayScore: parseInt(competition.competitors.find(c => c.homeAway === 'away').score) || 0,
          status: status.description,
          completed,
          inProgress,
          time: status.shortDetail,
          overtime: competition.status.period > 4,
          // Nuevos campos para análisis en vivo:
          statusType: status.state,          // 'pre', 'in', 'post'
          currentPeriod: competition.status.period,
          clock: competition.status.clock    // Tiempo restante en el periodo actual
        };
      });
    }
    
    // Actualizar la caché con los nuevos datos
    gamesCache[dateStr] = {
      data: games,
      timestamp: Date.now()
    };
    
    return games;
  } catch (error) {
    console.error(`Error fetching games for ${dateStr}:`, error);
    
    // Si hay un error pero tenemos datos en caché, devolver esos
    if (gamesCache[dateStr]) {
      console.warn("Using cached data due to API error");
      return gamesCache[dateStr].data;
    }
    
    return [];
  }
}


// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
  // Crea botón de menú móvil
const mobileMenuBtn = document.createElement('button');
mobileMenuBtn.className = 'mobile-menu-btn';
mobileMenuBtn.innerHTML = '<i class="fas fa-bars"></i>';
document.body.appendChild(mobileMenuBtn);

// Toggle del menú
mobileMenuBtn.addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('active');
});

// Cierra menú al seleccionar opción
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelector('.sidebar').classList.remove('active');
  });
});

  await loadTeams();
  setupNavigation();
  await loadPage(currentPage);
  requestNotificationPermission(); // Solicitar permisos al cargar
  
  // Verificar notificaciones cada minuto
  liveGamesCheckInterval = setInterval(() => {
    if (currentPage === 'today') {
      fetchAndDisplayTodayGames();
    }
  }, 60000); // 1 minuto
});

// Cargar todos los equipos
async function loadTeams() {
  try {
    const response = await fetch(TEAMS_API);
    const data = await response.json();
    
    allTeams = data.sports[0].leagues[0].teams
      .map(team => team.team)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    
    allTeams.forEach(team => {
      teamLogos[team.abbreviation] = team.logos?.[0]?.href;
    });
    
  } catch (error) {
    console.error("Error cargando equipos:", error);
    showError("No se pudieron cargar los equipos. Recarga la página.");
  }
}

// Configurar navegación
function setupNavigation() {
  const navLinks = document.querySelectorAll('.nav-link');
  
  navLinks.forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      document.querySelector('.sidebar').classList.remove('active');
      document.querySelector('.mobile-menu-btn').innerHTML = '<i class="fas fa-bars"></i>';
      
      // Remover clase active de todos los links
      navLinks.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      
      // Limpiar intervalos existentes
      if (liveGamesInterval) {
        clearInterval(liveGamesInterval);
        liveGamesInterval = null;
      }
      
      if (liveGamesCheckInterval) {
        clearInterval(liveGamesCheckInterval);
        liveGamesCheckInterval = null;
      }
      
      // Guardar el estado actual antes de cambiar de página
      if (currentPage === 'historical') {
        saveHistoricalState();
      } else if (currentPage === 'probabilities') {
        saveProbabilitiesState();
      } else if (currentPage === 'backtesting') {
        saveBacktestingState();
      } else if (currentPage === 'projection') {
        saveProjectionState();
      }
      
      // Actualizar página actual
      currentPage = link.dataset.page;
      await loadPage(currentPage);
      
      // Restaurar el estado de la nueva página
      restorePageState();
      
      // Configurar intervalos si es la página de partidos de hoy
      if (currentPage === 'today') {
        liveGamesInterval = setInterval(fetchAndDisplayTodayGames, 30000); // Actualizar cada 30 segundos
        liveGamesCheckInterval = setInterval(() => {
          fetchAndDisplayTodayGames();
        }, 60000); // Verificar notificaciones cada minuto
      }
    });
  });
}

function saveHistoricalState() {
  pageState.historical = {
    startDate: document.getElementById('start-date')?.value,
    endDate: document.getElementById('end-date')?.value,
    team: document.getElementById('team-filter')?.value,
    opponent: document.getElementById('opponent-filter')?.value
  };
}

function saveProbabilitiesState() {
  pageState.probabilities = {
    team: document.getElementById('prob-team')?.value,
    startDate: document.getElementById('prob-start-date')?.value,
    endDate: document.getElementById('prob-end-date')?.value
  };
}

function saveBacktestingState() {
  pageState.backtesting = {
    team: document.getElementById('backtest-team')?.value,
    startDate: document.getElementById('backtest-start')?.value,
    endDate: document.getElementById('backtest-end')?.value
  };
}

function saveProjectionState() {
  const projectionState = {
    team: document.getElementById('projection-team')?.value,
    moneylineOdds: document.getElementById('moneyline-odds')?.value,
    overOdds: document.getElementById('over-odds')?.value,
    underOdds: document.getElementById('under-odds')?.value
  };
  pageState.projection = projectionState;
}

function restorePageState() {
  if (currentPage === 'historical' && pageState.historical) {
    const state = pageState.historical;
    if (document.getElementById('start-date')) {
      document.getElementById('start-date').value = state.startDate || '';
      document.getElementById('end-date').value = state.endDate || '';
      document.getElementById('team-filter').value = state.team || '';
      document.getElementById('opponent-filter').value = state.opponent || '';
      
      if (state.startDate && state.endDate) {
        setTimeout(() => document.getElementById('search-historical')?.click(), 100);
      }
    }
  } else if (currentPage === 'probabilities' && pageState.probabilities) {
    const state = pageState.probabilities;
    if (document.getElementById('prob-team')) {
      document.getElementById('prob-team').value = state.team || '';
      document.getElementById('prob-start-date').value = state.startDate || '';
      document.getElementById('prob-end-date').value = state.endDate || '';
      
      if (state.team && state.startDate && state.endDate) {
        setTimeout(() => {
          document.getElementById('prob-team').dispatchEvent(new Event('change'));
        }, 100);
      }
    }
  } else if (currentPage === 'backtesting' && pageState.backtesting) {
    const state = pageState.backtesting;
    if (document.getElementById('backtest-team')) {
      document.getElementById('backtest-team').value = state.team || '';
      document.getElementById('backtest-start').value = state.startDate || '';
      document.getElementById('backtest-end').value = state.endDate || '';
      
      if (state.team && state.startDate && state.endDate) {
        setTimeout(() => document.getElementById('run-backtest')?.click(), 100);
      }
    }
  } else if (currentPage === 'projection' && pageState.projection) {
    const state = pageState.projection;
    if (document.getElementById('projection-team')) {
      document.getElementById('projection-team').value = state.team || '';
      
      if (state.team) {
        setTimeout(async () => {
          await updateProjectionData(state.team);
          // Restaurar valores de cuotas después de que se cargue la interfaz
          setTimeout(() => {
            if (state.moneylineOdds && document.getElementById('moneyline-odds')) {
              document.getElementById('moneyline-odds').value = state.moneylineOdds;
              calculateValue('moneyline', regressionModels[state.team]?.r2 || 0);
            }
            if (state.overOdds && document.getElementById('over-odds')) {
              document.getElementById('over-odds').value = state.overOdds;
              calculateValue('over', regressionModels[state.team]?.r2 || 0);
            }
            if (state.underOdds && document.getElementById('under-odds')) {
              document.getElementById('under-odds').value = state.underOdds;
              calculateValue('under', regressionModels[state.team]?.r2 || 0);
            }
          }, 300);
        }, 100);
      }
    }
  }
}

// Cargar página específica
async function loadPage(page) {
  const pageContent = document.getElementById('page-content');
  pageContent.innerHTML = '<div class="spinner"></div>';
  
  try {
    switch(page) {
      case 'today': await loadTodayGames(pageContent); break;
      case 'historical': await loadHistoricalGames(pageContent); break;
      case 'probabilities': await loadProbabilities(pageContent); break;
      case 'projection': await loadProjection(pageContent); break;
      case 'backtesting': await loadBacktesting(pageContent); break;
      default: await loadTodayGames(pageContent);
    }
  } catch (error) {
    console.error(`Error loading ${page} page:`, error);
    showError("Error al cargar los datos. Intenta nuevamente.");
  }
}

// 1. PARTIDOS HOY (Y EN VIVO)
async function loadTodayGames(container) {
  const today = new Date();
  const dateStr = formatDateForAPI(today);
  
  container.innerHTML = `
    <div class="page-header">
      <h2><i class="fas fa-calendar-day"></i> Partidos de Hoy</h2>
      <button class="refresh-btn" id="refresh-today">
        <i class="fas fa-sync-alt"></i> Actualizar
      </button>
    </div>
    <div class="games-container" id="today-games"></div>
  `;
  
  document.getElementById('refresh-today').addEventListener('click', fetchAndDisplayTodayGames);
  await fetchAndDisplayTodayGames();
  liveGamesInterval = setInterval(fetchAndDisplayTodayGames, 30000);
}

async function fetchAndDisplayTodayGames() {
  const today = new Date();
  const dateStr = formatDateForAPI(today);
  const gamesContainer = document.getElementById('today-games');
  
  gamesContainer.innerHTML = '<div class="spinner"></div>';

  try {
    const games = await fetchGamesForDate(dateStr);
    
    if (games.length === 0) {
      gamesContainer.innerHTML = `
        <div class="no-data" style="grid-column: 1 / -1;">
          <i class="fas fa-calendar-times" style="font-size: 2rem; color: #ccc; margin-bottom: 10px;"></i>
          <p>No hay partidos programados para hoy.</p>
        </div>
      `;
      return;
    }
    
    displayLiveGames(games, gamesContainer);
    monitorLiveGamesForNotifications(games); // Nueva función para monitoreo
    
    const liveGames = games.filter(game => !game.completed && game.inProgress);
    const liveBadge = document.getElementById('live-badge');
    liveBadge.style.display = liveGames.length > 0 ? 'block' : 'none';
    
  } catch (error) {
    console.error("Error fetching today's games:", error);
    gamesContainer.innerHTML = `
      <div class="error" style="grid-column: 1 / -1;">
        <i class="fas fa-exclamation-triangle" style="color: #f44336; font-size: 1.5rem; margin-bottom: 10px;"></i>
        <p>Error al cargar los partidos. Intenta nuevamente.</p>
      </div>
    `;
  }
}

function displayLiveGames(games, container) {
  container.innerHTML = '';
  
  games.forEach(game => {
    const gameCard = document.createElement('div');
    gameCard.className = 'game-card';
    
    const homeTeam = game.homeTeam;
    const awayTeam = game.awayTeam;
    const homeScore = game.homeScore;
    const awayScore = game.awayScore;
    
    const homeQuarters = game.homeScores || Array(4).fill(null);
    const awayQuarters = game.awayScores || Array(4).fill(null);
    
    let statusText = game.status;
    let statusClass = 'scheduled';
    
    if (game.completed) {
      statusText = 'Final';
      statusClass = 'completed';
    } else if (game.inProgress) {
      statusText = game.time || 'En vivo';
      statusClass = 'live';
    } else {
      statusText = game.time || 'Programado';
    }
    
    gameCard.innerHTML = `
      <div class="game-header">
        <span>${game.shortName}</span>
        <span class="game-status ${statusClass}">${statusText}</span>
      </div>
      <div class="game-teams">
        <div class="team-row">
          <div class="team-info">
            <img src="${teamLogos[awayTeam.abbreviation] || ''}" alt="${awayTeam.displayName}" class="team-logo">
            <span class="team-name">${awayTeam.displayName}</span>
          </div>
          <span class="team-score">${awayScore || '0'}</span>
        </div>
        <div class="team-row">
          <div class="team-info">
            <img src="${teamLogos[homeTeam.abbreviation] || ''}" alt="${homeTeam.displayName}" class="team-logo">
            <span class="team-name">${homeTeam.displayName}</span>
          </div>
          <span class="team-score">${homeScore || '0'}</span>
        </div>
      </div>
      <div class="quarters">
        <div class="quarter-header">1Q</div>
        <div class="quarter-header">2Q</div>
        <div class="quarter-header">3Q</div>
        <div class="quarter-header">4Q</div>
        <div class="quarter-header">T</div>
        <div class="quarter-value">${awayQuarters[0] || '-'}</div>
        <div class="quarter-value">${awayQuarters[1] || '-'}</div>
        <div class="quarter-value">${awayQuarters[2] || '-'}</div>
        <div class="quarter-value">${awayQuarters[3] || '-'}</div>
        <div class="quarter-value">${awayScore || '0'}</div>
        <div class="quarter-value">${homeQuarters[0] || '-'}</div>
        <div class="quarter-value">${homeQuarters[1] || '-'}</div>
        <div class="quarter-value">${homeQuarters[2] || '-'}</div>
        <div class="quarter-value">${homeQuarters[3] || '-'}</div>
        <div class="quarter-value">${homeScore || '0'}</div>
      </div>
      <div style="padding: 10px; text-align: center;">
        <button class="refresh-btn" style="padding: 8px 15px; font-size: 0.85rem;" data-game-id="${game.id}">
          <i class="fas fa-chart-line"></i> Análisis Pre-Partido
        </button>
        <button class="refresh-btn live-analysis-btn" style="padding: 8px 15px; font-size: 0.85rem; background-color: var(--live-color);" data-game-id="${game.id}">
          <i class="fas fa-bolt"></i> Análisis en Vivo
        </button>
      </div>
    `;
    
    container.appendChild(gameCard);
    
    // Event listener para análisis pre-partido
    gameCard.querySelector('button:not(.live-analysis-btn)').addEventListener('click', () => {
      showPreGameAnalysisModal(game);
    });
    
    // Event listener para análisis en vivo
    gameCard.querySelector('.live-analysis-btn').addEventListener('click', () => {
      showLiveAnalysisModal(game);
    });
  });
}

// 2. PARTIDOS HISTÓRICOS
async function loadHistoricalGames(container) {
  container.innerHTML = `
    <div class="page-header">
      <h2><i class="fas fa-history"></i> Partidos Históricos</h2>
    </div>
    <div class="filters-container">
      <div class="filter-group">
        <label class="filter-label">Fecha Inicial</label>
        <input type="date" id="start-date" class="filter-input">
      </div>
      <div class="filter-group">
        <label class="filter-label">Fecha Final</label>
        <input type="date" id="end-date" class="filter-input">
      </div>
      <div class="filter-group">
        <label class="filter-label">Equipo</label>
        <select id="team-filter" class="filter-input">
          <option value="">Todos los equipos</option>
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">Rival</label>
        <select id="opponent-filter" class="filter-input">
          <option value="">Todos los rivales</option>
        </select>
      </div>
    </div>
    <div class="table-actions">
      <button class="refresh-btn" id="search-historical">
        <i class="fas fa-search"></i> Buscar Partidos
      </button>
      <button class="refresh-btn" id="analyze-btn" style="background-color: #4caf50;">
        <i class="fas fa-chart-bar"></i> Analizar Datos
      </button>
    </div>
    <div class="table-container">
      <table class="stats-table" id="historical-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Equipo</th>
            <th>Rival</th>
            <th>1Q</th>
            <th>2Q</th>
            <th>3Q</th>
            <th>4Q</th>
            <th>TE</th>
            <th>Total</th>
            <th>Resultado</th>
          </tr>
        </thead>
        <tbody id="historical-data">
        </tbody>
      </table>
    </div>
    <div id="historical-stats"></div>
  `;
  
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - HISTORICAL_DAYS_LIMIT);
  
  document.getElementById('start-date').valueAsDate = startDate;
  document.getElementById('end-date').valueAsDate = endDate;
  
  fillTeamFilter('team-filter');
  fillTeamFilter('opponent-filter');
  
  document.getElementById('search-historical').addEventListener('click', searchHistoricalGames);
  document.getElementById('analyze-btn').addEventListener('click', analyzeHistoricalData);
  
  await searchHistoricalGames();
}

function fillTeamFilter(selectId) {
  const select = document.getElementById(selectId);
  select.innerHTML = '<option value="">Todos los equipos</option>';
  
  allTeams.forEach(team => {
    const option = document.createElement('option');
    option.value = team.abbreviation;
    option.textContent = team.displayName;
    select.appendChild(option);
  });
}

async function searchHistoricalGames() {
  const startDate = document.getElementById('start-date').value;
  const endDate = document.getElementById('end-date').value;
  const team = document.getElementById('team-filter').value;
  const opponent = document.getElementById('opponent-filter').value;
  
  if (!startDate || !endDate) {
    showError("Por favor selecciona ambas fechas");
    return;
  }
  
  if (new Date(startDate) > new Date(endDate)) {
    showError("La fecha inicial debe ser anterior a la fecha final");
    return;
  }
  
  try {
    const dateRange = getDatesBetween(startDate, endDate);
    const allGames = [];
    
    const tbody = document.getElementById('historical-data');
    tbody.innerHTML = '<tr><td colspan="10" style="text-align: center;"><div class="spinner"></div></td></tr>';
    
    for (const date of dateRange) {
      const games = await fetchGamesForDate(date);
      allGames.push(...games);
    }
    
    let filteredGames = allGames;
    
    if (team) {
      filteredGames = filteredGames.filter(game => 
        game.homeTeam.abbreviation === team || 
        game.awayTeam.abbreviation === team
      );
    }
    
    if (opponent) {
      filteredGames = filteredGames.filter(game => 
        game.homeTeam.abbreviation === opponent || 
        game.awayTeam.abbreviation === opponent
      );
    }
    
    displayHistoricalGames(filteredGames);
    historicalData = filteredGames;
    
  } catch (error) {
    console.error("Error searching historical games:", error);
    showError("Error al buscar partidos. Intenta nuevamente.");
  }
}

function displayHistoricalGames(games) {
  const tbody = document.getElementById('historical-data');
  tbody.innerHTML = '';
  
  if (games.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align: center; padding: 30px;">
          No se encontraron partidos con los filtros seleccionados.
        </td>
      </tr>
    `;
    return;
  }
  
  games.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  games.forEach(game => {
    addHistoricalGameRow(
      game.date,
      game.homeTeam,
      game.awayTeam,
      game.homeScores,
      game.overtime,
      game.homeScore,
      game.awayScore
    );
    
    addHistoricalGameRow(
      game.date,
      game.awayTeam,
      game.homeTeam,
      game.awayScores,
      game.overtime,
      game.awayScore,
      game.homeScore
    );
  });
}

function addHistoricalGameRow(date, team, opponent, scores, overtime, teamScore, opponentScore) {
  const tbody = document.getElementById('historical-data');
  const row = document.createElement('tr');
  row.className = 'fade-in';
  
  const formattedDate = formatReadableDate(date);
  const total = scores.reduce((sum, score) => sum + (score || 0), 0);
  const result = teamScore > opponentScore ? 'W' : 'L';
  const resultClass = result === 'W' ? 'win' : 'loss';
  
  row.innerHTML = `
    <td class="date-cell">${formattedDate}</td>
    <td>
      <img src="${teamLogos[team.abbreviation] || ''}" alt="${team.displayName}" class="team-logo">
      ${team.shortDisplayName || team.displayName}
    </td>
    <td>
      <img src="${teamLogos[opponent.abbreviation] || ''}" alt="${opponent.displayName}" class="team-logo">
      ${opponent.shortDisplayName || opponent.displayName}
    </td>
    <td>${scores[0] || '-'}</td>
    <td>${scores[1] || '-'}</td>
    <td>${scores[2] || '-'}</td>
    <td>${scores[3] || '-'}</td>
    <td>${overtime ? '✓' : ''}</td>
    <td>${teamScore || total}</td>
    <td class="${resultClass}">${result}</td>
  `;
  
  tbody.appendChild(row);
}

// 3. REGRESIÓN LINEAL
async function loadProbabilities(container) {
  container.innerHTML = `
    <div class="page-header">
      <h2><i class="fas fa-chart-line"></i> Regresión Lineal</h2>
      <button class="refresh-btn" id="refresh-probabilities">
        <i class="fas fa-sync-alt"></i> Actualizar Modelos
      </button>
    </div>
    
    <div class="info-box" style="margin-bottom: 20px; padding: 15px; background-color: #f8f9fa; border-radius: 8px; border-left: 4px solid var(--primary-color);">
      <h3 style="color: var(--primary-color); margin-bottom: 10px;"><i class="fas fa-info-circle"></i> ¿Qué es este análisis?</h3>
      <p style="margin-bottom: 10px;">
        Este análisis utiliza <strong>regresión lineal</strong> para predecir el puntaje final de un equipo basado en su desempeño en los primeros tres cuartos.
      </p>
      <p style="margin-bottom: 10px;">
        <strong>¿Cómo interpretar los resultados?</strong><br>
        - <strong>R² (Correlación):</strong> Indica qué tan bien se ajusta el modelo (0 = mal, 1 = perfecto)<br>
        - <strong>RMSE (Error):</strong> Muestra el margen de error promedio en puntos<br>
        - <strong>Ecuación:</strong> Total = (Pendiente × Suma 3Q) + Intercepto
      </p>
      <div id="last-updated" class="cache-info">
        <i class="fas fa-database"></i>
        <span>${regressionCache.lastUpdated ? `Última actualización: ${regressionCache.lastUpdated.toLocaleString('es-ES')}` : 'Datos no actualizados'}</span>
      </div>
    </div>
    
    <div class="filters-container">
      <div class="filter-group">
        <label class="filter-label">Equipo</label>
        <select id="prob-team" class="filter-input">
          <option value="">Selecciona un equipo</option>
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">Fecha Inicial</label>
        <input type="date" id="prob-start-date" class="filter-input">
      </div>
      <div class="filter-group">
        <label class="filter-label">Fecha Final</label>
        <input type="date" id="prob-end-date" class="filter-input">
      </div>
    </div>
    
    <div style="margin: 20px 0;">
      <button class="refresh-btn" id="run-backtest-from-regression" style="background-color: var(--secondary-color);">
        <i class="fas fa-flask"></i> Ejecutar Backtesting con Partidos Posteriores
      </button>
    </div>
    
    <div class="probability-grid">
      <div class="chart-container">
        <div class="chart-title">Modelo de Regresión</div>
        <canvas id="regression-chart"></canvas>
        <div id="regression-loading" style="text-align: center; margin-top: 20px; display: none;">
          <div class="spinner"></div>
          <p>Cargando datos del equipo...</p>
        </div>
      </div>
      <div class="chart-container">
        <div class="chart-title">Estadísticas del Modelo</div>
        <div id="regression-stats"></div>
      </div>
    </div>
    
    <div class="table-container" style="margin-top: 30px;">
      <div class="page-header" style="margin-bottom: 15px;">
        <h3><i class="fas fa-trophy"></i> Ranking de Modelos por Equipo</h3>
      </div>
      <table class="stats-table">
        <thead>
          <tr>
            <th>Equipo</th>
            <th>Correlación (R²)</th>
            <th>Pendiente</th>
            <th>Intercepto</th>
            <th>Error (RMSE)</th>
            <th>Partidos</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody id="teams-regression">
        </tbody>
      </table>
    </div>
    
    <div class="table-container" style="margin-top: 20px;">
      <div class="page-header" style="margin-bottom: 15px;">
        <h3><i class="fas fa-list"></i> Partidos Analizados para <span id="current-team-name">[Equipo Seleccionado]</span></h3>
      </div>
      <table class="stats-table" id="regression-games-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Local</th>
            <th>Visitante</th>
            <th>Suma 3Q</th>
            <th>Total Real</th>
            <th>Predicción</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody id="regression-games-data">
        </tbody>
      </table>
    </div>
  `;
  
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - HISTORICAL_DAYS_LIMIT);
  
  document.getElementById('prob-start-date').valueAsDate = startDate;
  document.getElementById('prob-end-date').valueAsDate = endDate;
  
  fillTeamFilter('prob-team');
  
  // Configurar event listeners
  document.getElementById('refresh-probabilities').addEventListener('click', () => {
    calculateAllRegressions(true); // true fuerza la actualización
  });
  
  document.getElementById('prob-team').addEventListener('change', async () => {
    const loadingDiv = document.getElementById('regression-loading');
    loadingDiv.style.display = 'block';
    
    try {
      await updateRegressionData();
    } catch (error) {
      console.error("Error updating regression data:", error);
      showError("Error al actualizar los datos de regresión");
    } finally {
      loadingDiv.style.display = 'none';
    }
  });
  
  document.getElementById('prob-start-date').addEventListener('change', calculateAllRegressions);
  document.getElementById('prob-end-date').addEventListener('change', calculateAllRegressions);
  
  document.getElementById('run-backtest-from-regression').addEventListener('click', async () => {
    const teamAbbr = document.getElementById('prob-team').value;
    const endDate = document.getElementById('prob-end-date').value;
    
    if (!teamAbbr) {
      showError("Selecciona un equipo primero");
      return;
    }
    
    if (!endDate) {
      showError("Selecciona una fecha final de análisis");
      return;
    }
    
    const nextDay = new Date(endDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayStr = nextDay.toISOString().split('T')[0];
    
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    const backtestTab = document.querySelector('.nav-link[data-page="backtesting"]');
    backtestTab.click();
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    document.getElementById('backtest-team').value = teamAbbr;
    document.getElementById('backtest-start').value = nextDayStr;
    document.getElementById('backtest-end').value = todayStr;
    
    document.getElementById('run-backtest').click();
  });
  
  await calculateAllRegressions();
}

async function calculateAllRegressions(forceRefresh = false) {
  const startDate = document.getElementById('prob-start-date').value;
  const endDate = document.getElementById('prob-end-date').value;
  const statsContainer = document.getElementById('teams-regression');
  
  // Verificar caché (si no se fuerza actualización)
  const now = new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
  
  if (!forceRefresh && regressionCache.data && regressionCache.lastUpdated > tenMinutesAgo) {
    displayRegressionStats(regressionCache.data.teamStats);
    
    const selectedTeam = document.getElementById('prob-team').value;
    if (selectedTeam && regressionCache.data.regressionModels[selectedTeam]) {
      currentRegressionData = regressionCache.data.regressionModels[selectedTeam];
      updateRegressionData();
    }
    
    updateLastUpdatedText();
    return;
  }
  
  statsContainer.innerHTML = '<tr><td colspan="7" style="text-align: center;"><div class="spinner"></div></td></tr>';
  
  if (!startDate || !endDate) {
    showError("Por favor selecciona ambas fechas");
    return;
  }
  
  if (new Date(startDate) > new Date(endDate)) {
    showError("La fecha inicial debe ser anterior a la fecha final");
    return;
  }
  
  try {
    const dateRange = getDatesBetween(startDate, endDate);
    const allGames = [];
    
    for (const date of dateRange) {
      const games = await fetchGamesForDate(date);
      allGames.push(...games);
    }
    
    regressionModels = {};
    const teamStats = [];
    
    allTeams.forEach(team => {
      const teamGames = allGames.filter(game => 
        game.homeTeam.abbreviation === team.abbreviation || 
        game.awayTeam.abbreviation === team.abbreviation
      );
      
      if (teamGames.length > 10) {
        const model = calculateTeamRegression(team, teamGames);
        regressionModels[team.abbreviation] = model;
        teamStats.push(model);
      }
    });
    
    // Actualizar la caché
    regressionCache = {
      lastUpdated: new Date(),
      data: {
        teamStats,
        regressionModels
      }
    };
    
    displayRegressionStats(teamStats);
    updateLastUpdatedText();
    
    const selectedTeam = document.getElementById('prob-team').value;
    if (selectedTeam && regressionModels[selectedTeam]) {
      currentRegressionData = regressionModels[selectedTeam];
      updateRegressionData();
    }
    
  } catch (error) {
    console.error("Error calculating regressions:", error);
    showError("Error al calcular los modelos. Intenta nuevamente.");
  }
}

function calculateTeamRegression(team, games) {
  const dataPoints = [];
  let sum3QTotal = 0;
  
  games.forEach(game => {
    const isHome = game.homeTeam.abbreviation === team.abbreviation;
    const quarters = isHome ? game.homeScores : game.awayScores;
    const totalScore = isHome ? game.homeScore : game.awayScore;
    
    if (quarters && quarters.length >= 3 && totalScore) {
      const sum3Q = quarters.slice(0, 3).reduce((sum, score) => sum + (score || 0), 0);
      dataPoints.push([sum3Q, totalScore]);
      sum3QTotal += sum3Q;
    }
  });
  
  if (dataPoints.length < 5) return null;
  
  const result = regression.linear(dataPoints);
  const avgSum3Q = sum3QTotal / dataPoints.length;
  const projectedTotal = result.equation[0] * avgSum3Q + result.equation[1];

  console.log(
    `Partidos válidos para ${team.abbreviation}: ${dataPoints.length} (requeridos: 5)\n`,
    `Datos faltantes en: ${games.length - dataPoints.length} partidos`
  );

  
  return {
    team: team,
    points: dataPoints,
    equation: result.equation,
    r2: result.r2,
    rmse: calculateRMSE(result, dataPoints),
    count: dataPoints.length,
    avgSum3Q: avgSum3Q,
    projectedTotal: projectedTotal
  };
}

function calculateLiveProjection(game, teamAbbr) {
  const model = regressionModels[teamAbbr];
  if (!model) return null;

  const isHome = game.homeTeam.abbreviation === teamAbbr;
  const quarters = isHome ? game.homeScores : game.awayScores;
  
  // Calcular suma de puntos hasta el cuarto actual
  let currentQuarter = 1;
  let sumCurrent = 0;
  
  // Determinar el cuarto actual basado en los puntos disponibles
  for (let i = 0; i < 4; i++) {
    if (quarters[i] !== null && quarters[i] !== undefined) {
      sumCurrent += quarters[i];
      currentQuarter = i + 1;
    } else {
      break;
    }
  }
  
  // Si no hay suficientes datos (menos de 1 cuarto completo)
  if (currentQuarter < 1) return null;
  
  // Calcular proyección basada en el modelo
  const projection = {
    team: teamAbbr,
    currentQuarter,
    currentPoints: sumCurrent,
    projectedTotal: model.equation[0] * sumCurrent + model.equation[1],
    confidence: model.r2 * 100,
    errorMargin: model.rmse
  };
  
  return projection;
}

function calculateRMSE(model, data) {
  let sumSquaredErrors = 0;
  const [a, b] = model.equation;
  
  data.forEach(point => {
    const [x, actualY] = point;
    const predictedY = a * x + b;
    sumSquaredErrors += Math.pow(actualY - predictedY, 2);
  });
  
  return Math.sqrt(sumSquaredErrors / data.length);
}

function displayRegressionStats(teamStats) {
  const container = document.getElementById('teams-regression');
  container.innerHTML = '';
  
  teamStats.sort((a, b) => b.r2 - a.r2);
  
  teamStats.forEach(model => {
    const row = document.createElement('tr');
    row.className = 'fade-in';
    
    row.innerHTML = `
      <td>
        <img src="${teamLogos[model.team.abbreviation] || ''}" alt="${model.team.displayName}" class="team-logo">
        ${model.team.displayName}
      </td>
      <td>${model.r2.toFixed(3)}</td>
      <td>${model.equation[0].toFixed(3)}</td>
      <td>${model.equation[1].toFixed(3)}</td>
      <td>${model.rmse.toFixed(1)}</td>
      <td>${model.count}</td>
      <td>
        <button class="project-btn" style="padding: 5px 10px; font-size: 0.8rem;" data-team="${model.team.abbreviation}">
          <i class="fas fa-chart-bar"></i> Proyectar
        </button>
      </td>
    `;
    
    container.appendChild(row);
  });
  
  // Agregar event listeners a los nuevos botones de proyección
  document.querySelectorAll('.project-btn').forEach(button => {
    button.addEventListener('click', async (e) => {
      const teamAbbr = e.currentTarget.getAttribute('data-team');
      
      // Cambiar a la pestaña de proyección
      const projectionTab = document.querySelector('.nav-link[data-page="projection"]');
      projectionTab.click();
      
      // Esperar a que la página se cargue
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Establecer el equipo seleccionado
      document.getElementById('projection-team').value = teamAbbr;
      
      // Disparar el evento change para cargar los datos
      document.getElementById('projection-team').dispatchEvent(new Event('change'));
    });
  });
}

function updateRegressionData() {
  updateRegressionChart();
  updateRegressionGamesTable();
}

function updateRegressionGamesTable() {
  const teamAbbr = document.getElementById('prob-team').value;
  const model = regressionModels[teamAbbr];
  const container = document.getElementById('regression-games-data');
  const teamNameSpan = document.getElementById('current-team-name');
  
  if (!model) {
    container.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center;">
          No hay suficientes datos para este equipo.
        </td>
      </tr>
    `;
    teamNameSpan.textContent = "[Equipo Seleccionado]";
    return;
  }
  
  teamNameSpan.textContent = model.team.displayName;
  container.innerHTML = '';
  
  model.gameDetails.forEach(game => {
    const [a, b] = model.equation;
    const predictedTotal = a * game.sum3Q + b;
    const error = game.totalScore - predictedTotal;
    
    const row = document.createElement('tr');
    row.className = 'fade-in';
    
    row.innerHTML = `
      <td>${formatReadableDate(game.date)}</td>
      <td>
        ${game.isHome ? 
          `<strong>${game.team.shortDisplayName || game.team.displayName}</strong>` : 
          game.team.shortDisplayName || game.team.displayName}
      </td>
      <td>
        ${!game.isHome ? 
          `<strong>${game.opponent.shortDisplayName || game.opponent.displayName}</strong>` : 
          game.opponent.shortDisplayName || game.opponent.displayName}
      </td>
      <td>${game.sum3Q}</td>
      <td>${game.totalScore}</td>
      <td>${predictedTotal.toFixed(1)}</td>
      <td class="${error >= 0 ? 'win' : 'loss'}">${error.toFixed(1)}</td>
    `;
    
    container.appendChild(row);
  });
}

function updateRegressionChart() {
  const teamAbbr = document.getElementById('prob-team').value;
  const model = regressionModels[teamAbbr];
  
  if (!model) {
    document.getElementById('regression-stats').innerHTML = `
      <div class="no-data">
        No hay suficientes datos para este equipo.
      </div>
    `;
    return;
  }
  
  document.getElementById('regression-stats').innerHTML = `
    <div class="model-stats">
      <p><strong>Equipo:</strong> ${model.team.displayName}</p>
      <p><strong>Ecuación:</strong> Total = ${model.equation[0].toFixed(3)} × (Suma 3Q) + ${model.equation[1].toFixed(3)}</p>
      <p><strong>Correlación (R²):</strong> ${model.r2.toFixed(3)}</p>
      <p><strong>Error (RMSE):</strong> ±${model.rmse.toFixed(1)} puntos</p>
      <p><strong>Partidos analizados:</strong> ${model.count}</p>
      <p><strong>Rango de fechas:</strong> ${formatReadableDate(document.getElementById('prob-start-date').value.split('-').reverse().join('/'))} - ${formatReadableDate(document.getElementById('prob-end-date').value.split('-').reverse().join('/'))}</p>
    </div>
  `;
  
  const ctx = document.getElementById('regression-chart').getContext('2d');
  
  if (window.regressionChart) {
    window.regressionChart.destroy();
  }
  
  window.regressionChart = new Chart(ctx, {
    type: 'scatter',
    data: {
      labels: model.points.map((point, i) => `P${i+1}`),
      datasets: [
        {
          label: 'Puntos reales',
          data: model.points.map(point => ({x: point[0], y: point[1]})),
          backgroundColor: 'rgba(29, 66, 138, 0.7)',
          borderColor: 'rgba(29, 66, 138, 1)',
          pointRadius: 6,
          pointHoverRadius: 8
        },
        {
          label: 'Línea de regresión',
          data: model.points.map(point => {
            const x = point[0];
            return {x, y: model.equation[0] * x + model.equation[1]};
          }),
          type: 'line',
          backgroundColor: 'rgba(201, 8, 42, 0.2)',
          borderColor: 'rgba(201, 8, 42, 1)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: {
          title: {
            display: true,
            text: 'Suma de puntos hasta el 3Q'
          }
        },
        y: {
          title: {
            display: true,
            text: 'Puntos totales'
          }
        }
      },
      plugins: {
        title: {
          display: true,
          text: `Modelo de predicción para ${model.team.displayName}`,
          font: {
            size: 16
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (context.parsed.y !== null) {
                label += `Total ${context.parsed.y} pts (3Q: ${context.parsed.x} pts)`;
              }
              return label;
            }
          }
        }
      }
    }
  });
}

// 4. PÁGINA DE PROYECCIÓN
async function loadProjection(container) {
  container.innerHTML = `
    <div class="page-header">
      <h2><i class="fas fa-project-diagram"></i> Proyección de Apuestas</h2>
    </div>
    
    <div class="info-box" style="margin-bottom: 20px; padding: 15px; background-color: #f8f9fa; border-radius: 8px; border-left: 4px solid var(--primary-color);">
      <h3 style="color: var(--primary-color); margin-bottom: 10px;"><i class="fas fa-info-circle"></i> ¿Qué es este análisis?</h3>
      <p style="margin-bottom: 10px;">
        Esta herramienta analiza las proyecciones basadas en el modelo de regresión lineal.
        Ingresa manualmente las cuotas disponibles para calcular el valor esperado.
      </p>
    </div>
    
    <div class="filters-container">
      <div class="filter-group">
        <label class="filter-label">Equipo</label>
        <select id="projection-team" class="filter-input">
          <option value="">Selecciona un equipo</option>
        </select>
      </div>
      <button class="refresh-btn" id="analyze-projection" style="margin-top: 10px;">
        <i class="fas fa-chart-bar"></i> Analizar Proyección
      </button>
    </div>
    
    <div id="projection-results" style="margin-top: 30px;">
      <div class="coming-soon">
        <i class="fas fa-chart-pie"></i>
        <p>Selecciona un equipo para ver las proyecciones de apuestas.</p>
      </div>
    </div>
  `;
  
  fillTeamFilter('projection-team');
  
  if (pageState.projection.team) {
    document.getElementById('projection-team').value = pageState.projection.team;
  }
  
  document.getElementById('projection-team').addEventListener('change', async () => {
    const teamAbbr = document.getElementById('projection-team').value;
    if (teamAbbr) {
      pageState.projection.team = teamAbbr;
    }
  });
  
  document.getElementById('analyze-projection').addEventListener('click', async () => {
    const teamAbbr = document.getElementById('projection-team').value;
    if (teamAbbr) {
      await updateProjectionData(teamAbbr);
    } else {
      showError("Selecciona un equipo primero");
    }
  });
}

async function updateProjectionData(teamAbbr) {
  const resultsContainer = document.getElementById('projection-results');
  resultsContainer.innerHTML = '<div class="spinner"></div>';
  
  try {
    const model = regressionModels[teamAbbr];
    
    if (!model) {
      resultsContainer.innerHTML = `
        <div class="no-data">
          No hay un modelo de regresión disponible para este equipo.
          Ve a la pestaña "Regresión Lineal" para generarlo primero.
        </div>
      `;
      return;
    }
    
    // Obtener el próximo partido del equipo
    const nextGame = await getNextGame(teamAbbr);
    const team = allTeams.find(t => t.abbreviation === teamAbbr);
    
    if (!nextGame) {
      // Mostrar tabla de cuotas genéricas basadas en el modelo
      displayGenericOddsTable(model, team);
      return;
    }
    
    const isHome = nextGame.homeTeam.abbreviation === teamAbbr;
    const opponent = isHome ? nextGame.awayTeam : nextGame.homeTeam;
    
    // Calcular proyección basada en promedio histórico de sum3Q
    const avgSum3Q = calculateAverageSum3Q(model);
    const projectedTotal = model.equation[0] * avgSum3Q + model.equation[1];
    
    // Mostrar interfaz para ingresar cuotas manualmente
    displayProjectionInterface(model, teamAbbr, opponent, projectedTotal);
    
  } catch (error) {
    console.error("Error updating projection:", error);
    showError("Error al actualizar proyección. Intenta nuevamente.");
  }
}

function displayGenericOddsTable(model, team) {
  const resultsContainer = document.getElementById('projection-results');
  
  resultsContainer.innerHTML = `
    <div class="probability-grid">
      <div class="chart-container">
        <div class="chart-title">Resumen del Modelo</div>
        <div class="model-stats">
          <p><strong>Equipo:</strong> ${team.displayName}</p>
          <p><strong>Correlación (R²):</strong> ${model.r2.toFixed(3)}</p>
          <p><strong>Error (RMSE):</strong> ±${model.rmse.toFixed(1)} puntos</p>
          <p><strong>Partidos analizados:</strong> ${model.count}</p>
        </div>
      </div>
    </div>
    
    <div class="table-container" style="margin-top: 30px;">
      <div class="page-header" style="margin-bottom: 15px;">
        <h3><i class="fas fa-coins"></i> Análisis de Valor Esperado</h3>
      </div>
      <table class="stats-table" id="projection-odds-table">
        <thead>
          <tr>
            <th>Capital</th>
            <th>% Efectividad</th>
            <th>Cuota</th>
            <th>Ganancia Proy.</th>
            <th>Pérdida Fija</th>
            <th>Valor Esperado</th>
            <th>Recomendación</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><input type="number" id="capital-1" class="odds-input" value="100" min="1"></td>
            <td>50%</td>
            <td>1.2</td>
            <td>20</td>
            <td>-40</td>
            <td>-10%</td>
            <td class="loss">No Recomendado</td>
          </tr>
          <tr>
            <td><input type="number" id="capital-2" class="odds-input" value="100" min="1"></td>
            <td>60%</td>
            <td>1.4</td>
            <td>40</td>
            <td>-30</td>
            <td>6%</td>
            <td class="neutral">Moderada</td>
          </tr>
          <tr>
            <td><input type="number" id="capital-3" class="odds-input" value="100" min="1"></td>
            <td>70%</td>
            <td>1.6</td>
            <td>60</td>
            <td>-20</td>
            <td>22%</td>
            <td class="win">Fuerte</td>
          </tr>
          <tr>
            <td><input type="number" id="capital-4" class="odds-input" value="100" min="1"></td>
            <td>80%</td>
            <td>1.8</td>
            <td>80</td>
            <td>-10</td>
            <td>44%</td>
            <td class="win">Muy Fuerte</td>
          </tr>
          <tr>
            <td><input type="number" id="capital-5" class="odds-input" value="100" min="1"></td>
            <td>90%</td>
            <td>2.0</td>
            <td>100</td>
            <td>0</td>
            <td>80%</td>
            <td class="win">Excelente</td>
          </tr>
        </tbody>
      </table>
    </div>
    
    <div class="info-box" style="margin-top: 20px;">
      <h3><i class="fas fa-lightbulb"></i> Recomendaciones basadas en el modelo</h3>
      <p>
        <strong>Cuando el equipo va perdiendo al 3Q:</strong> Considera apuestas en OVER si la suma de puntos al 3Q es menor que el promedio histórico (${calculateAverageSum3Q(model).toFixed(1)} pts), ya que suelen acelerar el ritmo en el último cuarto.
      </p>
      <p>
        <strong>Cuando el equipo va ganando al 3Q:</strong> Considera apuestas en UNDER si la suma de puntos al 3Q es mayor que el promedio histórico, ya que suelen reducir el ritmo para administrar el marcador.
      </p>
      <p>
        <strong>Margen de seguridad:</strong> Ajusta tus apuestas considerando el margen de error del modelo (±${model.rmse.toFixed(1)} pts).
      </p>
    </div>
  `;
  
  // Configurar event listeners para los inputs de capital
  document.querySelectorAll('#projection-odds-table input').forEach(input => {
    input.addEventListener('input', (e) => {
      const row = e.target.closest('tr');
      const capital = parseFloat(e.target.value) || 0;
      const effectiveness = parseFloat(row.cells[1].textContent) / 100;
      const odds = parseFloat(row.cells[2].textContent);
      
      // Calcular ganancia proyectada y pérdida fija
      const projectedGain = (capital * odds - capital) * effectiveness;
      const fixedLoss = capital * (1 - effectiveness);
      
      // Actualizar valores en la tabla
      row.cells[3].textContent = projectedGain.toFixed(0);
      row.cells[4].textContent = fixedLoss.toFixed(0);
      
      // Calcular valor esperado
      const expectedValue = (projectedGain - fixedLoss) / capital * 100;
      row.cells[5].textContent = expectedValue.toFixed(0) + '%';
      
      // Actualizar recomendación
      let recommendation, recommendationClass;
      if (expectedValue > 20) {
        recommendation = 'Excelente';
        recommendationClass = 'win';
      } else if (expectedValue > 10) {
        recommendation = 'Fuerte';
        recommendationClass = 'win';
      } else if (expectedValue > 0) {
        recommendation = 'Moderada';
        recommendationClass = 'neutral';
      } else {
        recommendation = 'No Recomendado';
        recommendationClass = 'loss';
      }
      
      row.cells[6].textContent = recommendation;
      row.cells[6].className = recommendationClass;
    });
  });
}

function calculateAverageSum3Q(model) {
  const sum3Qs = model.gameDetails.map(game => game.sum3Q);
  return sum3Qs.reduce((sum, val) => sum + val, 0) / sum3Qs.length;
}

async function getNextGame(teamAbbr) {
  const today = new Date();
  const nextDays = getDatesBetween(formatDateForAPI(today), formatDateForAPI(new Date(today.setDate(today.getDate() + 7))));
  
  for (const date of nextDays) {
    const games = await fetchGamesForDate(date);
    const teamGame = games.find(game => 
      game.homeTeam.abbreviation === teamAbbr || 
      game.awayTeam.abbreviation === teamAbbr
    );
    
    if (teamGame) {
      return teamGame;
    }
  }
  return null;
}

function displayProjectionInterface(model, teamAbbr, opponent, projectedTotal) {
  const team = allTeams.find(t => t.abbreviation === teamAbbr);
  const resultsContainer = document.getElementById('projection-results');
  
  resultsContainer.innerHTML = `
    <div class="probability-grid">
      <div class="chart-container">
        <div class="chart-title">Resumen del Modelo</div>
        <div class="model-stats">
          <p><strong>Equipo:</strong> ${team.displayName}</p>
          <p><strong>Próximo rival:</strong> ${opponent.displayName}</p>
          <p><strong>Correlación (R²):</strong> ${model.r2.toFixed(3)}</p>
          <p><strong>Error (RMSE):</strong> ±${model.rmse.toFixed(1)} puntos</p>
          <p><strong>Proyección de puntos:</strong> ${projectedTotal.toFixed(1)}</p>
        </div>
      </div>
    </div>
    
    <div class="table-container" style="margin-top: 30px;">
      <div class="page-header" style="margin-bottom: 15px;">
        <h3><i class="fas fa-list"></i> Análisis de Apuestas</h3>
      </div>
      <table class="stats-table" id="projection-odds-table">
        <thead>
          <tr>
            <th>Tipo Apuesta</th>
            <th>Línea</th>
            <th>Cuota</th>
            <th>Valor Esperado</th>
            <th>Recomendación</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Moneyline (Ganador)</td>
            <td>-</td>
            <td><input type="number" id="moneyline-odds" class="odds-input" placeholder="Ej: 2.50" step="0.01" min="1.01"></td>
            <td id="moneyline-value">-</td>
            <td id="moneyline-recommendation">-</td>
          </tr>
          <tr>
            <td>Puntos Totales (OVER)</td>
            <td>${projectedTotal.toFixed(1)}</td>
            <td><input type="number" id="over-odds" class="odds-input" placeholder="Ej: 1.90" step="0.01" min="1.01"></td>
            <td id="over-value">-</td>
            <td id="over-recommendation">-</td>
          </tr>
          <tr>
            <td>Puntos Totales (UNDER)</td>
            <td>${projectedTotal.toFixed(1)}</td>
            <td><input type="number" id="under-odds" class="odds-input" placeholder="Ej: 1.90" step="0.01" min="1.01"></td>
            <td id="under-value">-</td>
            <td id="under-recommendation">-</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
  
  // Configurar event listeners para los inputs de cuotas
  document.getElementById('moneyline-odds').addEventListener('input', () => calculateValue('moneyline', model.r2));
  document.getElementById('over-odds').addEventListener('input', () => calculateValue('over', model.r2));
  document.getElementById('under-odds').addEventListener('input', () => calculateValue('under', model.r2));
  
  // Restaurar valores anteriores si existen
  if (pageState.projection.moneylineOdds) {
    document.getElementById('moneyline-odds').value = pageState.projection.moneylineOdds;
    calculateValue('moneyline', model.r2);
  }
  if (pageState.projection.overOdds) {
    document.getElementById('over-odds').value = pageState.projection.overOdds;
    calculateValue('over', model.r2);
  }
  if (pageState.projection.underOdds) {
    document.getElementById('under-odds').value = pageState.projection.underOdds;
    calculateValue('under', model.r2);
  }
}

function calculateValue(betType, r2) {
  const oddsInput = document.getElementById(`${betType}-odds`);
  const valueCell = document.getElementById(`${betType}-value`);
  const recommendationCell = document.getElementById(`${betType}-recommendation`);
  
  // Guardar el estado actual de las cuotas
  saveProjectionState();
  
  if (!oddsInput.value || isNaN(oddsInput.value)) {
    valueCell.textContent = '-';
    recommendationCell.textContent = '-';
    return;
  }
  
  const odds = parseFloat(oddsInput.value);
  const impliedProbability = 1 / odds;
  
  // Calcular valor esperado basado en R²
  let estimatedProbability;
  switch(betType) {
    case 'moneyline':
      estimatedProbability = r2 * 0.9; // Ajuste para Moneyline
      break;
    case 'over':
    case 'under':
      estimatedProbability = r2 * 0.7; // Ajuste para Totales
      break;
    default:
      estimatedProbability = r2 * 0.8;
  }
  
  const expectedValue = (estimatedProbability * odds - 1) * 100;
  valueCell.textContent = `${expectedValue.toFixed(1)}%`;
  
  // Determinar recomendación
  let recommendation, recommendationClass;
  if (expectedValue > 15) {
    recommendation = 'Fuerte';
    recommendationClass = 'win';
  } else if (expectedValue > 5) {
    recommendation = 'Moderada';
    recommendationClass = 'neutral';
  } else {
    recommendation = 'Débil';
    recommendationClass = 'loss';
  }
  
  recommendationCell.textContent = recommendation;
  recommendationCell.className = recommendationClass;
}

// 5. BACKTESTING
async function loadBacktesting(container) {
  container.innerHTML = `
    <div class="page-header">
      <h2><i class="fas fa-flask"></i> Backtesting</h2>
    </div>
    <div class="filters-container">
      <div class="filter-group">
        <label class="filter-label">Equipo</label>
        <select id="backtest-team" class="filter-input">
          <option value="">Selecciona un equipo</option>
        </select>
      </div>
      <div class="filter-group">
        <label class="filter-label">Fecha Inicial</label>
        <input type="date" id="backtest-start" class="filter-input">
      </div>
      <div class="filter-group">
        <label class="filter-label">Fecha Final</label>
        <input type="date" id="backtest-end" class="filter-input">
      </div>
    </div>
    <button class="refresh-btn" id="run-backtest" style="margin-top: 20px;">
      <i class="fas fa-play"></i> Ejecutar Backtesting
    </button>
    <div id="backtest-results" style="margin-top: 30px;">
      <div class="coming-soon">
        <i class="fas fa-cog fa-spin"></i>
        <p>Selecciona un equipo y rango de fechas para ejecutar el backtesting.</p>
      </div>
    </div>
  `;
  
  fillTeamFilter('backtest-team');
  
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 30);
  
  document.getElementById('backtest-start').valueAsDate = startDate;
  document.getElementById('backtest-end').valueAsDate = endDate;
  
  document.getElementById('run-backtest').addEventListener('click', runBacktest);
}

async function runBacktest() {
  const teamAbbr = document.getElementById('backtest-team').value;
  const startDate = document.getElementById('backtest-start').value;
  const endDate = document.getElementById('backtest-end').value;
  
  if (!teamAbbr) {
    showError("Selecciona un equipo para realizar el backtesting");
    return;
  }
  
  if (!startDate || !endDate) {
    showError("Selecciona un rango de fechas válido");
    return;
  }
  
  try {
    const resultsContainer = document.getElementById('backtest-results');
    resultsContainer.innerHTML = '<div class="spinner"></div>';
    
    const dateRange = getDatesBetween(startDate, endDate);
    const allGames = [];
    
    for (const date of dateRange) {
      const games = await fetchGamesForDate(date);
      allGames.push(...games);
    }
    
    const teamGames = allGames.filter(game => 
      game.homeTeam.abbreviation === teamAbbr || 
      game.awayTeam.abbreviation === teamAbbr
    );
    
    const model = regressionModels[teamAbbr];
    
    if (!model) {
      resultsContainer.innerHTML = `
        <div class="no-data">
          No hay un modelo de regresión disponible para este equipo.
          Ve a la pestaña "Regresión Lineal" para generarlo.
        </div>
      `;
      return;
    }
    
    const backtestResults = [];
    const [a, b] = model.equation;
    
    teamGames.forEach(game => {
      const isHome = game.homeTeam.abbreviation === teamAbbr;
      const quarters = isHome ? game.homeScores : game.awayScores;
      const actualTotal = isHome ? game.homeScore : game.awayScore;
      
      if (quarters && quarters.length >= 3) {
        const sum3Q = quarters.slice(0, 3).reduce((sum, score) => sum + (score || 0), 0);
        const predictedTotal = a * sum3Q + b;
        const error = actualTotal - predictedTotal;
        
        backtestResults.push({
          date: game.date,
          opponent: isHome ? game.awayTeam : game.homeTeam,
          sum3Q,
          predictedTotal,
          actualTotal,
          error,
          isAccurate: Math.abs(error) <= model.rmse
        });
      }
    });
    
    displayBacktestResults(teamAbbr, backtestResults, model.rmse);
    
  } catch (error) {
    console.error("Error running backtest:", error);
    showError("Error al ejecutar el backtesting. Intenta nuevamente.");
  }
}

function displayBacktestResults(teamAbbr, results, rmse) {
  const container = document.getElementById('backtest-results');
  
  if (results.length === 0) {
    container.innerHTML = `
      <div class="no-data">
        No hay suficientes datos para realizar el backtesting.
      </div>
    `;
    return;
  }
  
  const accuratePredictions = results.filter(r => r.isAccurate).length;
  const accuracy = (accuratePredictions / results.length) * 100;
  const avgError = results.reduce((sum, r) => sum + Math.abs(r.error), 0) / results.length;
  
  container.innerHTML = `
    <div class="backtest-summary">
      <h3>Resumen de Backtesting</h3>
      <div class="summary-stats">
        <div class="stat-card">
          <div class="stat-value">${results.length}</div>
          <div class="stat-label">Partidos analizados</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${accuracy.toFixed(1)}%</div>
          <div class="stat-label">Precisión</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">±${avgError.toFixed(1)}</div>
          <div class="stat-label">Error promedio</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">±${rmse.toFixed(1)}</div>
          <div class="stat-label">RMSE modelo</div>
        </div>
      </div>
    </div>
    <div class="table-container" style="margin-top: 20px;">
      <table class="stats-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Rival</th>
            <th>Suma 3Q</th>
            <th>Predicción</th>
            <th>Real</th>
            <th>Error</th>
            <th>Precisión</th>
          </tr>
        </thead>
        <tbody>
          ${results.map(game => `
            <tr>
              <td>${formatReadableDate(game.date)}</td>
              <td>
                <img src="${teamLogos[game.opponent.abbreviation] || ''}" alt="${game.opponent.displayName}" class="team-logo">
                ${game.opponent.shortDisplayName || game.opponent.displayName}
              </td>
              <td>${game.sum3Q}</td>
              <td>${game.predictedTotal.toFixed(1)}</td>
              <td>${game.actualTotal}</td>
              <td class="${game.error >= 0 ? 'win' : 'loss'}">${game.error.toFixed(1)}</td>
              <td>
                <span class="${game.isAccurate ? 'win' : 'loss'}">
                  ${game.isAccurate ? '✓' : '✗'}
                </span>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// Modal de Análisis Pre-Partido
function showPreGameAnalysisModal(game) {
  const modal = document.getElementById('preGameModal');
  const modalContent = document.getElementById('modal-analysis-content');
  
  modalContent.innerHTML = `
    <div class="matchup-header">
      <div style="text-align: center;">
        <img src="${teamLogos[game.awayTeam.abbreviation] || ''}" alt="${game.awayTeam.displayName}" class="team-logo" style="width: 50px; height: 50px;">
        <h4>${game.awayTeam.displayName}</h4>
      </div>
      <div style="font-size: 1.5rem; font-weight: bold;">VS</div>
      <div style="text-align: center;">
        <img src="${teamLogos[game.homeTeam.abbreviation] || ''}" alt="${game.homeTeam.displayName}" class="team-logo" style="width: 50px; height: 50px;">
        <h4>${game.homeTeam.displayName}</h4>
      </div>
    </div>
    <div class="spinner"></div>
    <p style="text-align: center;">Cargando análisis pre-partido...</p>
  `;
  
  modal.style.display = 'block';
  
  loadPreGameAnalysisData(game).then(analysis => {
    displayRegressionAnalysisModal(analysis, game);
  }).catch(error => {
    modalContent.innerHTML = `
      <div class="error">
        <i class="fas fa-exclamation-triangle"></i>
        <p>Error al cargar el análisis pre-partido.</p>
      </div>
    `;
  });
  
  // Cerrar modal al hacer clic en la X
  document.querySelector('.close-modal').onclick = function() {
    modal.style.display = 'none';
  };
  
  // Cerrar modal al hacer clic fuera del contenido
  window.onclick = function(event) {
    if (event.target == modal) {
      modal.style.display = 'none';
    }
  };
}

// Añade estas funciones en index.js
function showLiveAnalysisModal(game) {
  const modal = document.getElementById('preGameModal');
  const modalContent = document.getElementById('modal-analysis-content');
  
  modalContent.innerHTML = `
    <div class="modal-header">
      <h3>Análisis en Vivo - ${game.shortName}</h3>
      <span class="close-modal">&times;</span>
    </div>
    <div class="teams-header">
      <div class="team-card">
        <img src="${teamLogos[game.awayTeam.abbreviation] || ''}" 
             alt="${game.awayTeam.displayName}" 
             class="team-logo-modal">
        <h4>${game.awayTeam.displayName}</h4>
        <div class="team-score">${game.awayScore || '0'}</div>
      </div>
      
      <div class="vs-circle">VS</div>
      
      <div class="team-card">
        <img src="${teamLogos[game.homeTeam.abbreviation] || ''}" 
             alt="${game.homeTeam.displayName}" 
             class="team-logo-modal">
        <h4>${game.homeTeam.displayName}</h4>
        <div class="team-score">${game.homeScore || '0'}</div>
      </div>
    </div>
    <div class="spinner"></div>
    <p style="text-align: center;">Cargando análisis en vivo...</p>
  `;
  
  modal.style.display = 'block';
  
  // Iniciar actualización en vivo
  const liveUpdate = startLiveAnalysis(game, modalContent);
  
  // Cerrar modal al hacer clic en la X
  document.querySelector('.close-modal').onclick = function() {
    liveUpdate.stop();
    modal.style.display = 'none';
  };
  
  // Cerrar modal al hacer clic fuera del contenido
  window.onclick = function(event) {
    if (event.target == modal) {
      liveUpdate.stop();
      modal.style.display = 'none';
    }
  };
}

function startLiveAnalysis(game, modalContent) {
  let intervalId;
  let isRunning = true;
  
  const updateAnalysis = async () => {
    try {
      // Obtener datos actualizados del partido
      const updatedGame = await fetchLiveGameData(game.name);
      
      // Calcular proyecciones para ambos equipos
      const awayProjection = calculateLiveProjection(updatedGame, updatedGame.awayTeam.abbreviation);
      const homeProjection = calculateLiveProjection(updatedGame, updatedGame.homeTeam.abbreviation);
      
      // Generar recomendación
      const recommendation = generateLiveRecommendation(awayProjection, homeProjection, updatedGame);
      
      // Actualizar el contenido del modal
      modalContent.innerHTML = createLiveAnalysisContent(updatedGame, awayProjection, homeProjection, recommendation);
      
    } catch (error) {
      console.error("Error en análisis en vivo:", error);
      modalContent.innerHTML = `
        <div class="error-box">
          <i class="fas fa-exclamation-triangle"></i>
          <p>Error al actualizar el análisis en vivo.</p>
          <small>${error.message}</small>
        </div>
      `;
      stop();
    }
  };
  
  // Ejecutar la primera actualización inmediatamente
  updateAnalysis();
  
  // Configurar intervalo para actualizaciones periódicas (cada 30 segundos)
  intervalId = setInterval(updateAnalysis, 30000);
  
  // Función para detener las actualizaciones
  const stop = () => {
    if (isRunning) {
      clearInterval(intervalId);
      isRunning = false;
    }
  };
  
  return {
    stop
  };
}

async function fetchLiveGameData(gameId) {
  try {
    // Usamos la fecha de hoy ya que es un partido en vivo
    const today = new Date();
    const dateStr = formatDateForAPI(today);
    const games = await fetchGamesForDate(dateStr);
    
    // Encontrar el juego actualizado
    const game = games.find(g => g.name === gameId);
    
    if (!game) {
      throw new Error("No se pudo encontrar el partido en los datos actualizados");
    }
    
    return game;
  } catch (error) {
    console.error("Error fetching live game data:", error);
    throw error;
  }
}

function createLiveAnalysisContent(game, awayProjection, homeProjection, recommendation) {
  const awayTeam = game.awayTeam;
  const homeTeam = game.homeTeam;
  
  return `
    <div class="modal-header">
      <h3>Análisis en Vivo - ${game.shortName}</h3>
      <span class="close-modal">&times;</span>
    </div>
    
    <div class="teams-header">
      <div class="team-card">
        <img src="${teamLogos[awayTeam.abbreviation] || ''}" 
             alt="${awayTeam.displayName}" 
             class="team-logo-modal">
        <h4>${awayTeam.displayName}</h4>
        <div class="team-score">${game.awayScore || '0'}</div>
      </div>
      
      <div class="vs-circle">VS</div>
      
      <div class="team-card">
        <img src="${teamLogos[homeTeam.abbreviation] || ''}" 
             alt="${homeTeam.displayName}" 
             class="team-logo-modal">
        <h4>${homeTeam.displayName}</h4>
        <div class="team-score">${game.homeScore || '0'}</div>
      </div>
    </div>
    
    <div class="live-analysis-container">
      <h4 style="color: var(--primary-color); margin-bottom: 15px; text-align: center;">
        <i class="fas fa-chart-line"></i> Proyecciones Actualizadas
      </h4>
      
      ${awayProjection && homeProjection ? `
        <div class="live-projection">
          <div class="live-projection-team">
            <div class="live-projection-value">${awayProjection.projectedTotal.toFixed(1)}</div>
            <div class="live-projection-label">${awayTeam.abbreviation} (Q${awayProjection.currentQuarter})</div>
          </div>
          
          <div class="live-projection-vs">vs</div>
          
          <div class="live-projection-team">
            <div class="live-projection-value">${homeProjection.projectedTotal.toFixed(1)}</div>
            <div class="live-projection-label">${homeTeam.abbreviation} (Q${homeProjection.currentQuarter})</div>
          </div>
        </div>
        
        <div class="live-stats">
          <div class="live-stat-card">
            <div class="live-stat-value">${(awayProjection.confidence).toFixed(1)}%</div>
            <div class="live-stat-label">Confianza ${awayTeam.abbreviation}</div>
          </div>
          
          <div class="live-stat-card">
            <div class="live-stat-value">${(homeProjection.confidence).toFixed(1)}%</div>
            <div class="live-stat-label">Confianza ${homeTeam.abbreviation}</div>
          </div>
          
          <div class="live-stat-card">
            <div class="live-stat-value">±${awayProjection.errorMargin.toFixed(1)}</div>
            <div class="live-stat-label">Margen error</div>
          </div>
          
          <div class="live-stat-card">
            <div class="live-stat-value">${game.status}</div>
            <div class="live-stat-label">Estado del partido</div>
          </div>
        </div>
      ` : `
        <div class="error-box">
          <i class="fas fa-exclamation-triangle"></i>
          <p>No hay suficientes datos para generar proyecciones en vivo.</p>
          <small>Espera a que se complete al menos el primer cuarto.</small>
        </div>
      `}
      
      <div class="recommendation-section" style="margin-top: 20px;">
        <h5><i class="fas fa-lightbulb"></i> Recomendación en Vivo</h5>
        <div class="recommendation-box ${recommendation.includes('Recomendamos') ? 'active' : 'warning'}">
          <p>${recommendation}</p>
        </div>
      </div>
      
      <div style="text-align: center; margin-top: 15px; font-size: 0.8rem; color: #666;">
        <i class="fas fa-sync-alt"></i> Actualizando automáticamente cada 30 segundos
      </div>
    </div>
  `;
}

function generateLiveRecommendation(awayProjection, homeProjection, game) {
  if (!awayProjection || !homeProjection) {
    return "Espera a que se complete al menos el primer cuarto para generar una recomendación.";
  }
  
  const homeTeam = game.homeTeam;
  const awayTeam = game.awayTeam;
  
  // Calcular diferencias
  const projectionDiff = homeProjection.projectedTotal - awayProjection.projectedTotal;
  const totalProjection = homeProjection.projectedTotal + awayProjection.projectedTotal;
  const currentDiff = (game.homeScore || 0) - (game.awayScore || 0);
  
  // Calcular confianza promedio
  const avgConfidence = (awayProjection.confidence + homeProjection.confidence) / 2;
  
  // Generar recomendación basada en múltiples factores
  let recommendation = "";
  
  // 1. Si hay una gran diferencia en las proyecciones
  if (Math.abs(projectionDiff) > 10) {
    const favoredTeam = projectionDiff > 0 ? homeTeam : awayTeam;
    const favoredName = favoredTeam.displayName;
    const favoredAbbr = favoredTeam.abbreviation;
    const diff = Math.abs(projectionDiff).toFixed(1);
    
    recommendation = `Recomendamos apuesta Moneyline en ${favoredName} (${favoredAbbr}). `;
    recommendation += `Proyección: +${diff} pts a favor con ${avgConfidence.toFixed(1)}% de confianza.`;
  } 
  // 2. Si el total proyectado es muy alto o bajo
  else if (totalProjection > 220) {
    recommendation = `Recomendamos apuesta OVER en puntos totales. `;
    recommendation += `Proyección: ${totalProjection.toFixed(1)} pts combinados con ${avgConfidence.toFixed(1)}% de confianza.`;
  } 
  else if (totalProjection < 200) {
    recommendation = `Recomendamos apuesta UNDER en puntos totales. `;
    recommendation += `Proyección: ${totalProjection.toFixed(1)} pts combinados con ${avgConfidence.toFixed(1)}% de confianza.`;
  } 
  // 3. Si el partido está muy parejo
  else {
    recommendation = `Partido muy equilibrado (diferencia de ${Math.abs(projectionDiff).toFixed(1)} pts). `;
    
    // Si hay una diferencia significativa en el marcador actual
    if (Math.abs(currentDiff) > 8) {
      const leadingTeam = currentDiff > 0 ? homeTeam : awayTeam;
      recommendation += `Considera apuesta en vivo en ${leadingTeam.displayName} que lleva ventaja de ${Math.abs(currentDiff)} pts.`;
    } else {
      recommendation += "Considera esperar al segundo cuarto para evaluar mejor el ritmo del partido.";
    }
  }
  
  // Añadir nota sobre el cuarto actual
  recommendation += ` (Análisis basado en Q${awayProjection.currentQuarter})`;
  
  return recommendation;
}

function displayRegressionAnalysisModal(analysis, game) {
  const modal = document.getElementById('preGameModal');
  const modalContent = document.getElementById('modal-analysis-content');
  
  // Crear contenido para cada equipo
  const createTeamAnalysis = (team, regression) => {
    if (!regression) {
      return `
        <div class="error-box">
          <i class="fas fa-exclamation-triangle"></i>
          <p>No se pudo generar análisis para ${team.displayName}</p>
          <small>No hay suficientes datos históricos</small>
        </div>
      `;
    }
    
    return `
      <div class="regression-stats">
        <p><strong>Ecuación:</strong> Total = ${regression.equation[0].toFixed(3)} × (Suma 3Q) + ${regression.equation[1].toFixed(3)}</p>
        <p><strong>Precisión (R²):</strong> ${regression.r2.toFixed(3)}</p>
        <p><strong>Error promedio:</strong> ±${regression.rmse.toFixed(1)} puntos</p>
        <p><strong>Partidos analizados:</strong> ${regression.count}</p>
        <p><strong>Proyección actual:</strong> ${regression.projectedTotal.toFixed(1)} puntos</p>
      </div>
      <canvas id="${team.abbreviation.toLowerCase()}-regression-chart"></canvas>
    `;
  };

  modalContent.innerHTML = `
    <div class="modal-header">
      <h3>Análisis Pre-Partido Avanzado</h3>
      <span class="close-modal">&times;</span>
    </div>
    
    <div class="teams-header">
      <div class="team-card">
        <img src="${teamLogos[game.awayTeam.abbreviation] || ''}" 
             alt="${game.awayTeam.displayName}" 
             class="team-logo-modal">
        <h4>${game.awayTeam.displayName}</h4>
      </div>
      
      <div class="vs-circle">VS</div>
      
      <div class="team-card">
        <img src="${teamLogos[game.homeTeam.abbreviation] || ''}" 
             alt="${game.homeTeam.displayName}" 
             class="team-logo-modal">
        <h4>${game.homeTeam.displayName}</h4>
      </div>
    </div>
    
    <div class="analysis-grid">
      <div class="analysis-card">
        <h5><i class="fas fa-chart-line"></i> ${game.awayTeam.displayName}</h5>
        ${createTeamAnalysis(game.awayTeam, analysis.awayRegression)}
      </div>
      
      <div class="analysis-card">
        <h5><i class="fas fa-chart-line"></i> ${game.homeTeam.displayName}</h5>
        ${createTeamAnalysis(game.homeTeam, analysis.homeRegression)}
      </div>
    </div>
    
    <div class="recommendation-section">
      <h5><i class="fas fa-lightbulb"></i> Recomendación</h5>
      <div class="recommendation-box ${!analysis.recommendation.includes('No hay') ? 'active' : 'warning'}">
        <p>${analysis.recommendation}</p>
      </div>
    </div>
  `;

  // Renderizar gráficos si hay datos
  if (analysis.awayRegression) {
    renderRegressionChart(`${game.awayTeam.abbreviation.toLowerCase()}-regression-chart`, analysis.awayRegression);
  }
  if (analysis.homeRegression) {
    renderRegressionChart(`${game.homeTeam.abbreviation.toLowerCase()}-regression-chart`, analysis.homeRegression);
  }

  modal.style.display = 'block';
}

async function loadPreGameAnalysisData(game) {
  const homeTeamAbbr = game.homeTeam.abbreviation;
  const awayTeamAbbr = game.awayTeam.abbreviation;
  
  try {
    // 1. Primero intentar usar modelos ya calculados
    let homeRegression = regressionModels[homeTeamAbbr];
    let awayRegression = regressionModels[awayTeamAbbr];
    
    console.log('Modelos existentes:', {
      home: homeRegression ? 'Encontrado' : 'No encontrado',
      away: awayRegression ? 'Encontrado' : 'No encontrado'
    });

    // 2. Si faltan modelos, calcularlos como en la pestaña Regresión
    if (!homeRegression || !awayRegression) {
      console.log('Calculando nuevos modelos...');
      const startDate = document.getElementById('prob-start-date')?.value || 
                       formatDateForAPI(new Date(new Date().setDate(new Date().getDate() - HISTORICAL_DAYS_LIMIT)));
      const endDate = document.getElementById('prob-end-date')?.value || 
                      formatDateForAPI(new Date());
      
      console.log(`Rango de fechas: ${startDate} a ${endDate}`);
      
      const dateRange = getDatesBetween(startDate, endDate);
      const allGames = [];
      
      // Obtener todos los partidos en el rango como en Regresión
      for (const date of dateRange) {
        const games = await fetchGamesForDate(date);
        allGames.push(...games);
      }
      
      // Filtrar para cada equipo
      if (!homeRegression) {
        const homeTeamGames = allGames.filter(g => 
          g.homeTeam.abbreviation === homeTeamAbbr || 
          g.awayTeam.abbreviation === homeTeamAbbr
        );
        homeRegression = calculateTeamRegression(game.homeTeam, homeTeamGames);
        console.log(`Partidos para ${homeTeamAbbr}:`, homeTeamGames.length);
      }
      
      if (!awayRegression) {
        const awayTeamGames = allGames.filter(g => 
          g.homeTeam.abbreviation === awayTeamAbbr || 
          g.awayTeam.abbreviation === awayTeamAbbr
        );
        awayRegression = calculateTeamRegression(game.awayTeam, awayTeamGames);
        console.log(`Partidos para ${awayTeamAbbr}:`, awayTeamGames.length);
      }
    }

    // 3. Generar recomendación
    const recommendation = generateRegressionRecommendation(homeRegression, awayRegression);
    
    console.log('Análisis completado:', { homeRegression, awayRegression });
    
    return {
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      homeRegression,
      awayRegression,
      recommendation
    };
    
  } catch (error) {
    console.error("Error en análisis pre-partido:", error);
    return {
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      homeRegression: null,
      awayRegression: null,
      recommendation: "Error técnico al generar el análisis. Ver consola para detalles."
    };
  }
}

function calculateTeamAverages(games, teamAbbr) {
  const sums = {
    sum3Q: 0,
    total: 0,
    q1: 0,
    q2: 0,
    q3: 0,
    q4: 0,
    count: 0
  };
  
  games.forEach(game => {
    const isHome = game.homeTeam.abbreviation === teamAbbr;
    const quarters = isHome ? game.homeScores : game.awayScores;
    const total = isHome ? game.homeScore : game.awayScore;
    
    if (quarters && quarters.length >= 3 && total) {
      const sum3Q = quarters.slice(0, 3).reduce((sum, score) => sum + (score || 0), 0);
      sums.sum3Q += sum3Q;
      sums.total += total;
      sums.q1 += quarters[0] || 0;
      sums.q2 += quarters[1] || 0;
      sums.q3 += quarters[2] || 0;
      sums.q4 += quarters[3] || 0;
      sums.count++;
    }
  });
  
  if (sums.count === 0) return null;
  
  return {
    avgSum3Q: sums.sum3Q / sums.count,
    avgTotal: sums.total / sums.count,
    avgQ1: sums.q1 / sums.count,
    avgQ2: sums.q2 / sums.count,
    avgQ3: sums.q3 / sums.count,
    avgQ4: sums.q4 / sums.count,
    gamesAnalyzed: sums.count
  };
}

function generateRecommendation(homeAvg, awayAvg, homeProjection, awayProjection, homeModel, awayModel) {
  if (!homeAvg || !awayAvg || !homeProjection || !awayProjection) {
    return {
      betType: "Datos insuficientes",
      confidence: 0,
      reasoning: "No hay suficientes datos históricos para generar una recomendación confiable.",
      riskLevel: 50
    };
  }
  
  // Calcular diferencia de proyecciones
  const projectionDiff = homeProjection - awayProjection;
  const totalProjection = homeProjection + awayProjection;
  
  // Determinar tipo de apuesta basado en promedios
  let betType, confidence, reasoning, riskLevel;
  
  if (projectionDiff > 5) {
    // Equipo local es significativamente mejor
    betType = "Gana local (Moneyline)";
    confidence = Math.min(70 + (homeModel?.r2 || 0) * 20, 90);
    reasoning = `El local (${homeAvg.team.displayName}) tiene una proyección más alta (${homeProjection.toFixed(1)} pts) que el visitante (${awayProjection.toFixed(1)} pts).`;
    riskLevel = 30;
  } else if (projectionDiff < -5) {
    // Equipo visitante es significativamente mejor
    betType = "Gana visitante (Moneyline)";
    confidence = Math.min(70 + (awayModel?.r2 || 0) * 20, 90);
    reasoning = `El visitante (${awayAvg.team.displayName}) tiene una proyección más alta (${awayProjection.toFixed(1)} pts) que el local (${homeProjection.toFixed(1)} pts).`;
    riskLevel = 30;
  } else if (totalProjection > 220) {
    // Alto total proyectado
    betType = "OVER en puntos totales";
    confidence = 65;
    reasoning = `Ambos equipos tienen una proyección alta de puntos (${totalProjection.toFixed(1)} pts combinados).`;
    riskLevel = 40;
  } else if (totalProjection < 200) {
    // Bajo total proyectado
    betType = "UNDER en puntos totales";
    confidence = 65;
    reasoning = `Ambos equipos tienen una proyección baja de puntos (${totalProjection.toFixed(1)} pts combinados).`;
    riskLevel = 40;
  } else {
    // Partido equilibrado
    betType = "Apuesta en vivo después del 1Q";
    confidence = 60;
    reasoning = `Partido equilibrado (${totalProjection.toFixed(1)} pts proyectados). Se recomienda esperar al primer cuarto para evaluar el ritmo del juego.`;
    riskLevel = 50;
  }
  
  // Ajustar confianza basada en modelos
  if (homeModel && awayModel) {
    const avgR2 = (homeModel.r2 + awayModel.r2) / 2;
    confidence = Math.min(confidence + (avgR2 - 0.5) * 50, 95);
    reasoning += ` Los modelos tienen una correlación promedio del ${(avgR2 * 100).toFixed(1)}%.`;
  }
  
  return {
    betType,
    confidence: Math.round(confidence),
    reasoning,
    riskLevel: Math.min(100, Math.max(0, riskLevel))
  };
}

function displayPreGameAnalysis(analysis, game) {
  if (!analysis || !analysis.homeAvg || !analysis.awayAvg) {
    document.getElementById('modal-analysis-content').innerHTML = `
      <div class="no-data">
        <i class="fas fa-exclamation-triangle"></i>
        <p>No hay suficientes datos históricos para generar un análisis.</p>
        <p>Intenta con otro partido o verifica que los equipos tengan partidos recientes.</p>
      </div>
    `;
    return;
  }

  const modalContent = document.getElementById('modal-analysis-content');
  
  modalContent.innerHTML = `
    <div class="matchup-header">
      <!-- Resto del código permanece igual -->
      <div class="team-analysis">
        <div class="analysis-card">
          <h4>${game.awayTeam.displayName}</h4>
          <p><strong>Últimos ${analysis.awayAvg?.gamesAnalyzed || 0} partidos:</strong></p>
          <p>Promedio puntos: ${analysis.awayAvg?.avgTotal?.toFixed(1) || 'N/A'}</p>
          <!-- Resto de los datos con comprobación de nulidad -->
        </div>
        <!-- Mismo patrón para el equipo local -->
      </div>
      <!-- Resto del modal -->
    </div>
  `;
}

function createRegressionHTML(regression) {
  if (!regression) return '<p>No hay suficientes datos para este equipo</p>';
  
  return `
    <div class="regression-stats">
      <p><strong>Ecuación:</strong> Total = ${regression.equation[0].toFixed(3)} × (Suma 3Q) + ${regression.equation[1].toFixed(3)}</p>
      <p><strong>R²:</strong> ${regression.r2.toFixed(3)}</p>
      <p><strong>Error (RMSE):</strong> ±${regression.rmse.toFixed(1)} puntos</p>
      <p><strong>Partidos analizados:</strong> ${regression.count}</p>
      <p><strong>Promedio suma 3Q:</strong> ${regression.avgSum3Q.toFixed(1)} pts</p>
      <p><strong>Proyección total:</strong> ${regression.projectedTotal.toFixed(1)} pts</p>
    </div>
  `;
}

function renderRegressionChart(canvasId, regression) {
  if (!regression) return;
  
  const ctx = document.getElementById(canvasId).getContext('2d');
  
  new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Datos reales',
        data: regression.points.map(p => ({x: p[0], y: p[1]})),
        backgroundColor: 'rgba(29, 66, 138, 0.7)'
      }, {
        label: 'Línea de regresión',
        data: regression.points.map(p => ({
          x: p[0],
          y: regression.equation[0] * p[0] + regression.equation[1]
        })),
        type: 'line',
        borderColor: 'rgba(201, 8, 42, 1)',
        borderWidth: 2,
        pointRadius: 0
      }]
    },
    options: {
      scales: {
        x: { title: { display: true, text: 'Suma de puntos al 3Q' } },
        y: { title: { display: true, text: 'Puntos totales' } }
      }
    }
  });
}

/* FUNCIONES AUXILIARES PARA ANÁLISIS DE REGRESIÓN */
function generateRegressionRecommendation(homeRegression, awayRegression) {
  if (!homeRegression || !awayRegression) {
    return "No hay suficientes datos para generar una recomendación.";
  }
  
  const homeAdvantage = homeRegression.projectedTotal - awayRegression.projectedTotal;
  const totalProjected = homeRegression.projectedTotal + awayRegression.projectedTotal;
  const avgR2 = (homeRegression.r2 + awayRegression.r2) / 2;
  
  let recommendation = "";
  let confidence = Math.min(70 + (avgR2 - 0.5) * 40, 90);
  
  if (homeAdvantage > 8) {
    recommendation = `Fuerte ventaja para ${homeRegression.team.displayName} (${homeAdvantage.toFixed(1)} pts). `;
    recommendation += `Considera apuesta Moneyline en local con ${confidence.toFixed(0)}% de confianza.`;
  } else if (homeAdvantage < -8) {
    recommendation = `Fuerte ventaja para ${awayRegression.team.displayName} (${Math.abs(homeAdvantage).toFixed(1)} pts). `;
    recommendation += `Considera apuesta Moneyline en visitante con ${confidence.toFixed(0)}% de confianza.`;
  } else if (totalProjected > 220) {
    recommendation = `Alto total proyectado (${totalProjected.toFixed(1)} pts). `;
    recommendation += `Considera apuesta OVER en puntos totales con ${confidence.toFixed(0)}% de confianza.`;
  } else if (totalProjected < 200) {
    recommendation = `Bajo total proyectado (${totalProjected.toFixed(1)} pts). `;
    recommendation += `Considera apuesta UNDER en puntos totales con ${confidence.toFixed(0)}% de confianza.`;
  } else {
    recommendation = `Partido equilibrado (${totalProjected.toFixed(1)} pts totales proyectados). `;
    recommendation += `Espera al primer cuarto para evaluar el ritmo del juego.`;
  }
  
  recommendation += ` Los modelos tienen una correlación promedio del ${(avgR2 * 100).toFixed(1)}%.`;
  
  return recommendation;
}

/* FUNCIONES AUXILIARES COMUNES */

// Agrega esta función en tu index.js, preferiblemente junto con las otras funciones auxiliares
async function getLastNGames(teamAbbr, n) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - HISTORICAL_DAYS_LIMIT * 2); // Buscar en un rango más amplio
  
  const dateRange = getDatesBetween(formatDateForAPI(startDate), formatDateForAPI(endDate));
  const allGames = [];
  
  // Recopilar todos los juegos en el rango de fechas
  for (const date of dateRange) {
    const games = await fetchGamesForDate(date);
    allGames.push(...games);
  }
  
  // Filtrar juegos del equipo específico
  const teamGames = allGames.filter(game => 
    game.homeTeam.abbreviation === teamAbbr || 
    game.awayTeam.abbreviation === teamAbbr
  );
  
  // Ordenar por fecha (más reciente primero) y tomar los primeros N
  return teamGames
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, n);
}

async function fetchGamesForDate(dateStr) {
  if (gamesCache[dateStr] && (Date.now() - gamesCache[dateStr].timestamp < CACHE_DURATION)) {
    return gamesCache[dateStr].data;
  }
  
  try {
    const response = await fetch(`${API_URL}?dates=${dateStr}`);
    const data = await response.json();
    
    let games = [];
    
    if (data.events && data.events.length > 0) {
      games = data.events.map(event => {
        const competition = event.competitions[0];
        const homeTeam = competition.competitors.find(c => c.homeAway === 'home').team;
        const awayTeam = competition.competitors.find(c => c.homeAway === 'away').team;
        
        const homeScores = getQuarterScores(competition.competitors.find(c => c.homeAway === 'home'));
        const awayScores = getQuarterScores(competition.competitors.find(c => c.homeAway === 'away'));
        
        const status = competition.status.type;
        const completed = status.completed;
        const inProgress = !completed && status.state === 'in';
        
        return {
          date: dateStr,
          name: event.name,
          shortName: event.shortName,
          homeTeam,
          awayTeam,
          homeScores,
          awayScores,
          homeScore: parseInt(competition.competitors.find(c => c.homeAway === 'home').score) || 0,
          awayScore: parseInt(competition.competitors.find(c => c.homeAway === 'away').score) || 0,
          status: competition.status.type.description,
          completed,
          inProgress,
          time: competition.status.type.shortDetail,
          overtime: competition.status.period > 4
        };
      });
    }
    
    gamesCache[dateStr] = {
      data: games,
      timestamp: Date.now()
    };
    
    return games;
  } catch (error) {
    console.error(`Error fetching games for ${dateStr}:`, error);
    return [];
  }
}

function getQuarterScores(competitor) {
  if (!competitor.linescores || competitor.linescores.length === 0) {
    return Array(4).fill(null);
  }
  
  return competitor.linescores.map(period => period.value);
}

function formatDateForAPI(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function formatReadableDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return 'Fecha inválida';
  
  try {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    return `${parseInt(day)}/${parseInt(month)}/${year}`;
  } catch (e) {
    return 'Fecha inválida';
  }
}

function getDatesBetween(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  
  while (current <= end) {
    dates.push(formatDateForAPI(new Date(current)));
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

function formatGameTime(dateStr, timeStr) {
  if (!timeStr) return '';
  const timeMatch = timeStr.match(/(\d+:\d+ [AP]M)/);
  return timeMatch ? timeMatch[1] : '';
}

function showError(message) {
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-message';
  errorDiv.innerHTML = `
    <i class="fas fa-exclamation-circle"></i>
    <span>${message}</span>
  `;
  
  document.body.appendChild(errorDiv);
  setTimeout(() => errorDiv.remove(), 5000);
}

function analyzeHistoricalData() {
  console.log("Análisis de datos históricos");
}
function requestNotificationPermission() {
  if (!("Notification" in window)) {
    console.log("Este navegador no soporta notificaciones");
    return;
  }

  Notification.requestPermission().then(permission => {
    notificationPermission = permission === "granted";
    if (notificationPermission) {
      console.log("Permiso para notificaciones concedido");
    }
  });
}

function updateLastUpdatedText() {
  const lastUpdatedElement = document.getElementById('last-updated');
  if (lastUpdatedElement && regressionCache.lastUpdated) {
    const options = { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric', 
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit'
    };
    lastUpdatedElement.textContent = `Última actualización: ${regressionCache.lastUpdated.toLocaleDateString('es-ES', options)}`;
  }
}
function showNotification(title, options) {
  if (!notificationPermission) return;

  // Verificar si el servicio de notificaciones está disponible
  if (!("Notification" in window)) {
    console.log("Este navegador no soporta notificaciones");
    return;
  }

  // Mostrar notificación
  if (Notification.permission === "granted") {
    new Notification(title, options);
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then(permission => {
      if (permission === "granted") {
        new Notification(title, options);
      }
    });
  }
}

function monitorLiveGamesForNotifications(games) {
  // Limpiar temporizadores anteriores para juegos que ya no están activos
  Object.keys(notificationTimers).forEach(gameId => {
    if (!games.some(game => game.id === gameId)) {
      clearTimeout(notificationTimers[gameId]);
      delete notificationTimers[gameId];
    }
  });

  games.forEach(game => {
    // Notificación 10 minutos antes del partido
    if (game.statusType === 'pre') {
      const gameTime = new Date(game.date);
      const tenMinutesBefore = new Date(gameTime.getTime() - 10 * 60 * 1000);
      
      if (!notificationTimers[`start_${game.id}`] && new Date() < tenMinutesBefore && tenMinutesBefore < new Date(gameTime.getTime())) {
        notificationTimers[`start_${game.id}`] = setTimeout(() => {
          showNotification(
            `Partido por comenzar: ${game.shortName}`,
            {
              body: `El partido entre ${game.awayTeam.displayName} vs ${game.homeTeam.displayName} comenzará en 10 minutos`,
              icon: teamLogos[game.homeTeam.abbreviation]
            }
          );
        }, tenMinutesBefore - new Date());
      }
    }

    // Notificación para el 3er cuarto
    if (game.inProgress && game.currentPeriod === 3 && !notificationTimers[`q3_${game.id}`]) {
      const quarterEndTime = calculateQuarterEndTime(game.clock);
      
      if (quarterEndTime > 0) {
        const twoMinutesBeforeEnd = quarterEndTime - 2 * 60 * 1000;
        
        if (twoMinutesBeforeEnd > 0) {
          notificationTimers[`q3_${game.id}`] = setTimeout(() => {
            showNotification(
              `Finalizando 3er cuarto: ${game.shortName}`,
              {
                body: `Quedan 2 minutos para el final del 3er cuarto (${game.awayTeam.abbreviation} ${game.awayScore} - ${game.homeScore} ${game.homeTeam.abbreviation})`,
                icon: teamLogos[game.homeTeam.abbreviation]
              }
            );
          }, twoMinutesBeforeEnd);
        }
      }
    }
  });
}

function calculateQuarterEndTime(clock) {
  if (!clock) return 0;
  
  const [minutes, seconds] = clock.split(':').map(Number);
  return (minutes * 60 + seconds) * 1000; // Devuelve tiempo en milisegundos
}