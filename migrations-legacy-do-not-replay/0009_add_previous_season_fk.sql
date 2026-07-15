ALTER TABLE "leagues" ADD CONSTRAINT "leagues_previous_season_id_fk" FOREIGN KEY ("previous_season_id") REFERENCES "leagues"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
