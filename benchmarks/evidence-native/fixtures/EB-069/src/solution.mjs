export function chooseTextColor(background) {
  const average = (background.r + background.g + background.b) / 3;
  return average > 128 ? "#000000" : "#ffffff";
}
