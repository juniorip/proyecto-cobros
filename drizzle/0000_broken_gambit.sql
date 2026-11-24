CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`created` text NOT NULL,
	`added` integer NOT NULL,
	`duplicates` integer NOT NULL,
	`conflicts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`code` text PRIMARY KEY NOT NULL,
	`client` text NOT NULL,
	`account` text NOT NULL,
	`date` text NOT NULL,
	`time` text NOT NULL,
	`cents` integer NOT NULL,
	`channel` text NOT NULL,
	`raw` text NOT NULL,
	`filename` text NOT NULL,
	`status` text DEFAULT 'Pendiente' NOT NULL,
	`document` text DEFAULT 'Sin asignar' NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`rate` integer DEFAULT 100 NOT NULL
);
