"use client";

import { Activity, Check, ChevronDown, Gauge, HardDrive, Network } from "lucide-react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import type { OperationModel } from "../lib/dashboard-data";
import { handleDirectionalFocus } from "../lib/directional-focus";
import { useInterfaceStore } from "../stores/interface-store";

export function OperationsDock({ operations }: { operations: OperationModel[] }) {
  const expanded = useInterfaceStore((state) => state.operationsExpanded);
  const setExpanded = useInterfaceStore((state) => state.setOperationsExpanded);
  const average =
    operations.length > 0
      ? operations.reduce((total, operation) => total + operation.progress, 0) / operations.length
      : 0;
  const averagePercent = Math.round(average * 100);

  if (operations.length === 0) {
    return (
      <section
        className="operations-dock operations-dock--empty"
        aria-labelledby="operations-heading"
      >
        <div className="operations-dock__summary" role="status">
          <span className="operations-dock__beacon" aria-hidden="true">
            <Check size={18} />
          </span>
          <span className="operations-dock__title">
            <span className="section-kicker">Operations quiet</span>
            <strong id="operations-heading">No acquisitions in flight</strong>
          </span>
          <span className="operations-dock__quiet-copy">Your download queue is clear.</span>
        </div>
      </section>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <section
        className="operations-dock"
        data-expanded={expanded || undefined}
        aria-labelledby="operations-heading"
        onKeyDown={(event) => handleDirectionalFocus(event, { axis: "vertical" })}
      >
        <button
          aria-controls="operations-details"
          aria-expanded={expanded}
          className="operations-dock__summary"
          data-directional-item
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          <span className="operations-dock__beacon" aria-hidden="true">
            <Activity size={18} />
          </span>
          <span className="operations-dock__title">
            <span className="section-kicker">Live operations</span>
            <strong id="operations-heading">{operations.length} acquisitions moving</strong>
          </span>
          <span
            aria-label="Average acquisition progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={averagePercent}
            className="operations-dock__meter"
            role="progressbar"
          >
            <span aria-hidden="true" style={{ width: `${averagePercent}%` }} />
          </span>
          <span className="operations-dock__metric">
            <Network aria-hidden="true" size={15} /> 61.0 MB/s
          </span>
          <span className="operations-dock__metric">
            <HardDrive aria-hidden="true" size={15} /> 4.8 TB free
          </span>
          <ChevronDown aria-hidden="true" className="operations-dock__chevron" size={19} />
        </button>
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              animate={{ height: "auto" }}
              className="operations-dock__details"
              exit={{ height: 0, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
              id="operations-details"
              initial={{ height: 0 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="operations-dock__list">
                {operations.map((operation) => (
                  <button
                    className="operation-row"
                    data-directional-item
                    key={operation.id}
                    type="button"
                  >
                    <span className="operation-row__icon" aria-hidden="true">
                      <Gauge size={17} />
                    </span>
                    <span className="operation-row__copy">
                      <strong>{operation.title}</strong>
                      <span>{operation.service}</span>
                    </span>
                    <span
                      aria-label={`${operation.title} progress`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={Math.round(operation.progress * 100)}
                      className="operation-row__progress"
                      role="progressbar"
                    >
                      <span
                        aria-hidden="true"
                        style={{ width: `${Math.round(operation.progress * 100)}%` }}
                      />
                    </span>
                    <span className="operation-row__rate">{operation.rate}</span>
                    <span className="operation-row__eta">{operation.eta}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </MotionConfig>
  );
}
