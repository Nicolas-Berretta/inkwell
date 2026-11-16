import { useAppStore } from '../store/appStore';
import { TextBox } from './TextBox';

/** Renders the rich-text boxes of the open page inside the camera-transformed layer. */
export function TextLayer() {
  const textBoxes = useAppStore((s) => s.textBoxes);
  const focusTextBoxId = useAppStore((s) => s.focusTextBoxId);
  return (
    <>
      {textBoxes.map((box) => (
        <TextBox key={box.id} box={box} autoFocus={box.id === focusTextBoxId} />
      ))}
    </>
  );
}
