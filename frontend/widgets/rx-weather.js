import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

export class RxWeather extends LitElement {
  static properties = {
    weatherData: { type: Object },
    location: { type: String },
    timezone: { type: String },
    chunkId: { type: String }
  };

  static styles = css`
    :host {
      display: block;
    }
    
    .weather-card {
      max-width: 400px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 1rem;
      padding: 1.5rem;
      color: white;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
      animation: fadeIn 0.3s ease-out;
    }
    
    @keyframes fadeIn { 
      from { opacity: 0; transform: translateY(10px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
    
    .current-weather {
      text-align: center;
      margin-bottom: 1.5rem;
    }
    
    .weather-icon {
      font-size: 4rem;
      margin-bottom: 0.5rem;
    }
    
    .temperature {
      font-size: 3rem;
      font-weight: 700;
      line-height: 1;
    }
    
    .temperature-unit {
      font-size: 1.5rem;
      font-weight: 400;
    }
    
    .condition {
      font-size: 1.1rem;
      opacity: 0.9;
      margin-top: 0.5rem;
    }
    
    .location {
      font-size: 0.9rem;
      opacity: 0.8;
      margin-top: 0.25rem;
    }
    
    .details {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1rem;
      padding: 1rem;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 0.75rem;
      margin-bottom: 1rem;
    }
    
    .detail-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .detail-icon {
      font-size: 1.25rem;
    }
    
    .detail-label {
      font-size: 0.75rem;
      opacity: 0.7;
    }
    
    .detail-value {
      font-size: 1rem;
      font-weight: 600;
    }
    
    .forecast {
      border-top: 1px solid rgba(255, 255, 255, 0.2);
      padding-top: 1rem;
    }
    
    .forecast-title {
      font-size: 0.9rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      opacity: 0.9;
    }
    
    .forecast-days {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
    }
    
    .forecast-day {
      text-align: center;
      flex: 1;
      padding: 0.5rem;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 0.5rem;
      min-width: 0;
    }
    
    .day-name {
      font-size: 0.7rem;
      opacity: 0.8;
      margin-bottom: 0.25rem;
    }
    
    .day-icon {
      font-size: 1.5rem;
      margin-bottom: 0.25rem;
    }
    
    .day-temps {
      font-size: 0.7rem;
    }
    
    .day-high {
      font-weight: 600;
    }
    
    .day-low {
      opacity: 0.7;
    }
    
    .source {
      text-align: center;
      font-size: 0.7rem;
      opacity: 0.6;
      margin-top: 1rem;
    }
  `;

  constructor() {
    super();
    this.weatherData = null;
    this.location = '';
    this.timezone = '';
    this.chunkId = '';
  }

  getWeatherIcon(code) {
    if (code === 0) return '☀️';
    if (code === 1) return '🌤️';
    if (code === 2) return '⛅';
    if (code === 3) return '☁️';
    if (code >= 45 && code <= 48) return '🌫️';
    if (code >= 51 && code <= 57) return '🌦️';
    if (code >= 61 && code <= 67) return '🌧️';
    if (code >= 71 && code <= 77) return '🌨️';
    if (code >= 80 && code <= 82) return '🌦️';
    if (code >= 85 && code <= 86) return '🌨️';
    if (code >= 95) return '⛈️';
    return '🌡️';
  }

  getWeatherDescription(code) {
    const codes = {
      0: 'Clear sky',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Overcast',
      45: 'Fog',
      48: 'Rime fog',
      51: 'Light drizzle',
      53: 'Drizzle',
      55: 'Heavy drizzle',
      56: 'Freezing drizzle',
      57: 'Freezing drizzle',
      61: 'Light rain',
      63: 'Rain',
      65: 'Heavy rain',
      66: 'Freezing rain',
      67: 'Freezing rain',
      71: 'Light snow',
      73: 'Snow',
      75: 'Heavy snow',
      77: 'Snow grains',
      80: 'Rain showers',
      81: 'Rain showers',
      82: 'Heavy showers',
      85: 'Snow showers',
      86: 'Heavy snow showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm with hail',
      99: 'Thunderstorm with hail'
    };
    return codes[code] || 'Unknown';
  }

  formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  }

  getWindDirection(degrees) {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(degrees / 22.5) % 16;
    return directions[index];
  }

  render() {
    if (!this.weatherData) {
      return html`
        <div class="weather-card">
          <div class="current-weather">
            <div class="condition">Loading weather...</div>
          </div>
        </div>
      `;
    }

    const { current, daily } = this.weatherData;
    const icon = this.getWeatherIcon(current.weathercode);
    const description = this.getWeatherDescription(current.weathercode);
    const windDir = this.getWindDirection(current.winddirection);

    return html`
      <div class="weather-card" data-chunk-id=${this.chunkId}>
        <div class="current-weather">
          <div class="weather-icon">${icon}</div>
          <div class="temperature">${Math.round(current.temperature)}<span class="temperature-unit">°C</span></div>
          <div class="condition">${description}</div>
          <div class="location">${this.location || `${this.weatherData.location.latitude.toFixed(2)}, ${this.weatherData.location.longitude.toFixed(2)}`}</div>
        </div>
        
        <div class="details">
          <div class="detail-item">
            <span class="detail-icon">💨</span>
            <div>
              <div class="detail-label">Wind</div>
              <div class="detail-value">${Math.round(current.windspeed)} km/h ${windDir}</div>
            </div>
          </div>
          <div class="detail-item">
            <span class="detail-icon">🕐</span>
            <div>
              <div class="detail-label">Updated</div>
              <div class="detail-value">${new Date(current.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          </div>
        </div>
        
        ${daily && daily.length > 0 ? html`
          <div class="forecast">
            <div class="forecast-title">7-Day Forecast</div>
            <div class="forecast-days">
              ${daily.slice(0, 7).map(day => html`
                <div class="forecast-day">
                  <div class="day-name">${this.formatDate(day.date)}</div>
                  <div class="day-icon">${this.getWeatherIcon(day.weathercode)}</div>
                  <div class="day-temps">
                    <span class="day-high">${Math.round(day.maxTemp)}°</span>
                    <span class="day-low">${Math.round(day.minTemp)}°</span>
                  </div>
                </div>
              `)}
            </div>
          </div>
        ` : ''}
        
        <div class="source">Powered by Open-Meteo API</div>
      </div>
    `;
  }
}

customElements.define('rx-weather', RxWeather);
