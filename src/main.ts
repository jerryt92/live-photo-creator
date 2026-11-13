import { createApp } from 'vue'
import '@fontsource/sora/latin-500.css'
import '@fontsource/sora/latin-600.css'
import '@fontsource/sora/latin-700.css'
import '@fontsource/sora/latin-800.css'
import './styles/tokens.css'
import './styles/base.css'
import App from './App.vue'
import { reveal } from './directives/reveal'

const app = createApp(App)
app.directive('reveal', reveal)
app.mount('#app')
