import { CalendarOff, CalendarRange } from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";
import type { CalendarItemModel } from "../lib/dashboard-data";
import { DirectionalNavigationGroup } from "./directional-navigation-group";

type CalendarStyle = CSSProperties & { "--calendar-accent": string };

export function CalendarStrip({ items }: { items: CalendarItemModel[] }) {
  return (
    <section className="calendar-strip" aria-labelledby="upcoming-heading">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Release cadence</p>
          <h2 id="upcoming-heading">This week</h2>
        </div>
        {items.length > 0 && (
          <Link className="icon-text-action" href="/calendar" prefetch={false}>
            <CalendarRange aria-hidden="true" size={17} /> Open calendar
          </Link>
        )}
      </div>
      {items.length > 0 ? (
        <DirectionalNavigationGroup axis="grid" className="calendar-strip__grid">
          {items.map((item) => (
            <button
              className="calendar-item"
              data-directional-item
              key={item.id}
              style={{ "--calendar-accent": item.accent } as CalendarStyle}
              type="button"
            >
              <span className="calendar-item__day">{item.day}</span>
              <span className="calendar-item__marker" aria-hidden="true" />
              <span className="calendar-item__copy">
                <strong>{item.title}</strong>
                <span>{item.service}</span>
              </span>
            </button>
          ))}
        </DirectionalNavigationGroup>
      ) : (
        <div className="quiet-state quiet-state--calendar" role="status">
          <span className="quiet-state__icon" aria-hidden="true">
            <CalendarOff size={20} />
          </span>
          <span>
            <strong>No arrivals scheduled</strong>
            <span>Upcoming episodes and requested releases will appear here.</span>
          </span>
        </div>
      )}
    </section>
  );
}
