"use client";

import { verificationTasks } from '@/data/mockData';
import { User, Calendar, CheckCircle2, Pencil, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function TasksPanel() {
  return (
    <div className="h-full overflow-y-auto p-4 animate-fade-in">
      <h3 className="text-sm font-semibold mb-3">Verification Tasks</h3>
      <div className="space-y-3">
        {verificationTasks.map(task => (
          <div key={task.id} className="rounded-lg border bg-card p-3 space-y-2">
            <p className="text-sm leading-relaxed italic text-muted-foreground">"{task.snippet}"</p>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <User className="h-3 w-3" />
                @{task.assignee.split(' ')[0].toLowerCase()}
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {task.dueDate}
              </span>
              <span className="badge-status badge-needs-review ml-auto">Pending</span>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                <CheckCircle2 className="h-3 w-3" /> Confirm
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                <Pencil className="h-3 w-3" /> Edit
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                <HelpCircle className="h-3 w-3" /> Request info
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
