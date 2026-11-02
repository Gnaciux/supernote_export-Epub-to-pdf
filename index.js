/**
 * Export EPUB to PDF — plugin entry.
 */
import { AppRegistry, Image } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { PluginManager } from 'sn-plugin-lib';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// Toolbar button inside documents (EPUB, PDF…). Opens the export dialog.
PluginManager.registerButton(1, ['DOC'], {
  id: 4101,
  name: 'Export to PDF',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});
