import { Icon } from '@astryxdesign/core/Icon';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Monitor, Moon, Sun } from 'lucide-react';
import { THEME_CHOICES, useTheme } from './theme.js';

export const THEME_OPTIONS = {
  system: { label: 'System', Icon: Monitor },
  light: { label: 'Light', Icon: Sun },
  dark: { label: 'Dark', Icon: Moon },
};

export function ThemeSegmented({ labels = true, labelledBy }) {
  const { preference, setPreference } = useTheme();
  return (
    <SegmentedControl value={preference} onChange={setPreference} label={labelledBy ? 'Theme' : 'Appearance'} size="sm">
      {THEME_CHOICES.map((choice) => {
        const { label, Icon: ChoiceIcon } = THEME_OPTIONS[choice];
        return <SegmentedControlItem key={choice} value={choice} label={label} isLabelHidden={!labels} icon={<Icon icon={ChoiceIcon} />} />;
      })}
    </SegmentedControl>
  );
}
