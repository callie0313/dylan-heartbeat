# Weather Dashboard

A beautiful, responsive weather dashboard that displays real-time weather information for any city in the world.

## Features

✨ **Key Features:**
- 🌍 Search weather for any city worldwide
- 🌡️ Real-time temperature, humidity, wind speed, and pressure
- 📅 5-day weather forecast with detailed predictions
- 🎨 Beautiful gradient UI with smooth animations
- 📱 Fully responsive design (works on desktop, tablet, mobile)
- 🚀 Fast and lightweight
- 🔓 No API key required
- 💾 Uses free Open-Meteo API

## Weather Information Displayed

### Current Weather
- **Temperature**: Current temperature in Celsius
- **Feels Like**: Apparent temperature adjusted for wind
- **Weather Condition**: Description with emoji icon
- **Humidity**: Percentage of moisture in the air
- **Wind Speed**: Current wind speed in km/h
- **Pressure**: Atmospheric pressure in hPa
- **Visibility**: How far you can see

### 5-Day Forecast
- Daily high and low temperatures
- Weather condition for each day
- Wind speed information
- Weather emoji icons

## How to Use

1. **Open the Dashboard**: Open `index.html` in your web browser
2. **Search for a City**: 
   - Type a city name in the search box
   - Click the "Search" button or press Enter
3. **View Weather**: The current weather and forecast will be displayed

## Default City

The dashboard loads weather for **London** by default when you first open it.

## Technologies Used

- **HTML5**: Semantic markup structure
- **CSS3**: Modern styling with gradients and animations
- **JavaScript (ES6+)**: Dynamic functionality and API calls
- **Open-Meteo API**: Free weather data (no API key needed)
- **Geocoding API**: Convert city names to coordinates

## API Integration

This dashboard uses the **Open-Meteo API**, which is:
- ✅ Free to use
- ✅ No authentication required
- ✅ No rate limits for reasonable use
- ✅ CORS-enabled for browser requests

### API Endpoints Used:
1. **Geocoding API**: `https://geocoding-api.open-meteo.com/v1/search`
   - Converts city names to latitude/longitude
   
2. **Weather API**: `https://api.open-meteo.com/v1/forecast`
   - Retrieves current weather and forecast data

## File Structure

```
weather-dashboard/
├── index.html      # HTML structure
├── styles.css      # Styling and animations
├── app.js          # JavaScript functionality
└── README.md       # This file
```

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Mobile)

## Features Breakdown

### Search Functionality
```javascript
// Type city name and press Enter or click Search button
// The app handles:
// - City name resolution
// - Timezone detection
// - Weather data fetching
// - Error handling for invalid cities
```

### Real-time Updates
- Click the last updated timestamp to refresh data
- Data is fetched fresh each time you search

### Responsive Design
- **Desktop**: Multi-column layout with full details
- **Tablet**: 2-column grid for forecasts
- **Mobile**: Single column layout optimized for small screens

## Weather Code Interpretation

The dashboard uses WMO (World Meteorological Organization) weather codes to determine:
- Weather descriptions (Clear, Cloudy, Rainy, etc.)
- Appropriate emoji icons (☀️, ⛅, 🌧️, ❄️, etc.)

## Customization

### Change Default City
Edit line in `app.js`:
```javascript
this.loadWeather('London');  // Change 'London' to your preferred city
```

### Modify Temperature Unit
Change the `temperature_unit` parameter in `getWeatherData()`:
```javascript
temperature_unit: 'celsius'  // Or 'fahrenheit'
```

### Adjust Forecast Days
Change the `forecast_days` parameter (1-16 days available):
```javascript
forecast_days: 5  // Change to 7, 10, etc.
```

## Future Enhancements

- 🗺️ Add map view showing weather across regions
- 📍 Geolocation detection to auto-load user's location
- 💾 Save favorite cities
- 📊 Historical weather data and trends
- 🔔 Weather alerts and notifications
- 🌙 Dark mode toggle
- 🌍 Multiple language support
- 📈 Air quality index (AQI) data

## License

MIT License - Feel free to use and modify

## Credits

- Weather data: [Open-Meteo](https://open-meteo.com/)
- Icons: Unicode Emoji
- Fonts: System fonts (Segoe UI, etc.)

## Support

For issues or questions, please open an issue on the repository.

---

**Made with ❤️ for weather enthusiasts**
