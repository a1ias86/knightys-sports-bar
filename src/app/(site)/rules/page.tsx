import { POINTS } from '@/lib/scoring';

export const metadata = { title: 'Rules' };

export default function RulesPage() {
  return (
    <div className="stack" style={{ maxWidth: 780 }}>
      <h1>How points work</h1>
      <section className="panel">
        <p>For every Arsenal match you predict three things: the score, the first goalscorer and the first player to get an assist. Picks lock at kick-off.</p>
        <div className="table-wrap">
          <table>
            <tbody>
              <tr><td>Correct first goalscorer</td><td className="r points-cell">{POINTS.scorer}</td></tr>
              <tr><td>Correct first assister</td><td className="r points-cell">{POINTS.assister}</td></tr>
              <tr><td>Your goalscorer pick made the first assist instead</td><td className="r points-cell">{POINTS.crossover}</td></tr>
              <tr><td>Your assister pick scored the first goal instead</td><td className="r points-cell">{POINTS.crossover}</td></tr>
              <tr><td>Correct result (Arsenal win, draw or Arsenal defeat)</td><td className="r points-cell">{POINTS.result}</td></tr>
              <tr><td>Correct total number of goals in the match</td><td className="r points-cell">{POINTS.totalGoals}</td></tr>
              <tr><td>Full house bonus: all four of the above main picks right</td><td className="r points-cell">+{POINTS.fullHouseBonus}</td></tr>
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>The best possible score for a match is 15.</p>
      </section>

      <section className="panel">
        <h2>The details</h2>
        <h3>Result and total goals</h3>
        <p>The result point is for the right outcome, not the exact score: predict 2–2 and it finishes 1–1, and you get the point. The total goals point is for the number of goals: predict 3–1 and it finishes 2–2, and you get the point (four goals either way), but not the result point.</p>
        <h3>First goalscorer</h3>
        <p>The first player to score for either team. Own goals don&rsquo;t count for anyone&rsquo;s pick: if the first goal is an own goal, the next proper goal decides it. If there are no goals (or only own goals), &ldquo;No goalscorer&rdquo; wins, and you can only pick that with a 0–0 prediction.</p>
        <h3>First assister</h3>
        <p>The first player officially credited with an assist, in match order. If the first goal had no assist, it&rsquo;s the next assisted goal. The same player can be first scorer and first assister. If no goal has an assist, &ldquo;No assister&rdquo; wins.</p>
        <h3>Crossovers</h3>
        <p>If the player you picked to score made the first assist instead, you get 3 instead of 5 for that pick, and the same the other way round. Crossovers don&rsquo;t count towards the full house.</p>
        <h3>Substitutes and line-ups</h3>
        <p>Your picks never change after kick-off. If your player doesn&rsquo;t start, comes off or gets injured, the pick stands. When line-ups are published before kick-off the app flags picks who aren&rsquo;t starting so you can swap them in time.</p>
        <h3>Checking the data</h3>
        <p>Points are only added once the scorer and assist are confirmed. If the data is missing or doubtful, Jon or Knighty check it first. Postponed matches reopen when they&rsquo;re rescheduled; abandoned matches don&rsquo;t score.</p>
      </section>
    </div>
  );
}
