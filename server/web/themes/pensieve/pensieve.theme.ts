// The pensieve theme. `astryx experimental theme editor` wrote this file once and never changes it again.
// The checked settings live in pensieve.settings.json and the generated pensieve.settings.ts;
// change them with `astryx experimental theme editor set pensieve ...`. Add your own changes below: they win over the settings.
import {defineTheme} from '@astryxdesign/core/theme';
import {pensieveSettings} from './pensieve.settings';

export const pensieveTheme = defineTheme({
  extends: pensieveSettings,
  name: 'pensieve',
});
