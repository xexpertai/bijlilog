// Fixed synthetic demo plan shared by seed.mjs and the replay fixture. Not real outages.
export const PLACES = { "411001": "Synthetic: Pune GPO area", "560001": "Synthetic: Bengaluru MG Road area", "226001": "Synthetic: Lucknow Hazratganj area" };
// (days ago, start hour IST, duration minutes, confirmers) per PIN: fixed, so a run is reproducible.
export const PLAN = {
  "411001": [[27, 14, 95, 2], [24, 23, 210, 3], [20, 6, 45, 0], [15, 18, 130, 1], [11, 2, 300, 4], [6, 13, 70, 0], [2, 21, 160, 2]],
  "560001": [[26, 10, 60, 1], [19, 16, 185, 2], [12, 22, 250, 3], [5, 7, 40, 0]],
  "226001": [[25, 12, 280, 5], [21, 19, 120, 2], [17, 1, 330, 4], [9, 15, 90, 1], [3, 20, 200, 3]],
};
